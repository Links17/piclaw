/**
 * Multi-replica turn/SSE load smoke.
 *
 * Starts two Brain replicas over the same PG/Redis, creates isolated sessions,
 * submits concurrent mock turns across both replicas, and verifies all complete
 * exactly once with persisted usage.
 */
import { sql } from "@piclaw-cloud/store/db";
import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { spawnBrain } from "../src/e2e/spawn-brain.ts";

const BASE_CONFIG = new URL("../../brain.config.llm-e2e.json", import.meta.url).pathname;
const PORT_A = Number(process.env.CLOUD_LOAD_PORT_A || 17941);
const PORT_B = Number(process.env.CLOUD_LOAD_PORT_B || 17942);
const CONCURRENCY = Number(process.env.CLOUD_LOAD_CONCURRENCY || 20);
const SAME_SESSION_CONCURRENCY = Number(process.env.CLOUD_LOAD_SAME_SESSION_CONCURRENCY || 8);
const MAX_FAILURE_RATE = Number(process.env.CLOUD_LOAD_MAX_FAILURE_RATE || 0);
const MAX_P95_MS = Number(process.env.CLOUD_LOAD_MAX_P95_MS || 15_000);
const run = new RealAcceptance();

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue))] ?? 0;
}

async function waitFor(predicate: () => Promise<boolean>, name: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${name}`);
}

async function collectSseUntil(
  baseUrl: string,
  sessionId: string,
  done: (events: Array<{ event: string; data: Record<string, unknown> }>) => boolean,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const response = await fetch(`${baseUrl}/sse/stream?chat_jid=${encodeURIComponent(sessionId)}`);
  if (!response.ok || !response.body) throw new Error(`SSE failed: ${response.status}`);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!done(events)) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? "message";
      const raw = block.match(/^data: (.+)$/m)?.[1];
      if (raw) events.push({ event, data: JSON.parse(raw) as Record<string, unknown> });
    }
  }
  await reader.cancel();
  return events;
}

try {
  await run.preflight(null, { skipBrain: true });
  // Preflight applies migrations; replicas skip DDL so concurrent tests cannot deadlock.
  const a = await spawnBrain({
    port: PORT_A,
    replicaId: `${run.id}-load-a`,
    baseConfigPath: BASE_CONFIG,
    apiKey: "mock-key",
    overrides: {
      sandbox: { enabled: false },
      auth: { required: false },
      openai: { baseUrl: "http://mock.invalid/v1", apiKey: "mock-key", model: "mock-model" },
      limits: { maxDailyTokensPerUser: 5_000_000 },
    },
    env: { CLOUD_LLM_MOCK: "1" },
    skipMigrations: true,
  });
  run.trackProcess("load-a", a.stop);
  const b = await spawnBrain({
    port: PORT_B,
    replicaId: `${run.id}-load-b`,
    baseConfigPath: BASE_CONFIG,
    apiKey: "mock-key",
    overrides: {
      sandbox: { enabled: false },
      auth: { required: false },
      openai: { baseUrl: "http://mock.invalid/v1", apiKey: "mock-key", model: "mock-model" },
      limits: { maxDailyTokensPerUser: 5_000_000 },
    },
    env: { CLOUD_LLM_MOCK: "1" },
    skipMigrations: true,
  });
  run.trackProcess("load-b", b.stop);

  const sessions = Array.from({ length: CONCURRENCY }, (_, index) => run.session(`load-${index}`));
  await Promise.all(sessions.map((id, index) =>
    fetch(`${index % 2 ? a.baseUrl : b.baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: `load ${index}` }),
    })
  ));

  const startedAt = Date.now();
  const results = await Promise.all(sessions.map(async (id, index) => {
    const base = index % 2 ? b.baseUrl : a.baseUrl;
    const requestStartedAt = performance.now();
    const response = await fetch(`${base}/agent/default/message?chat_jid=${encodeURIComponent(id)}&wait=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `hello quick load-${index}` }),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { error: text.slice(0, 200), status: response.status };
    }
    return { ok: response.ok, body, latencyMs: performance.now() - requestStartedAt };
  }));
  const failures = results
    .map((result, index) => ({ index, ...result }))
    .filter((result) => !result.ok || result.body.outcome !== "ran");
  const failureRate = failures.length / Math.max(1, results.length);
  const latencies = results.map((result) => result.latencyMs);
  const latency = {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  };
  run.check(
    failureRate <= MAX_FAILURE_RATE,
    "all concurrent turns complete",
    failures.length ? JSON.stringify(failures.slice(0, 5)) : undefined,
  );

  const persisted = await sql`
    SELECT COUNT(*)::int AS sessions,
      COUNT(*) FILTER (WHERE assistant_count = 1)::int AS exactly_once
    FROM (
      SELECT s.id, COUNT(m.id) FILTER (
        WHERE m.role = 'assistant' AND (m.content_blocks IS NULL OR NOT (m.content_blocks ? 'tool_calls'))
      ) AS assistant_count
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.id IN ${sql(sessions)}
      GROUP BY s.id
    ) q`;
  run.check(Number(persisted[0]?.sessions ?? 0) === CONCURRENCY, "all load sessions persisted");
  run.check(Number(persisted[0]?.exactly_once ?? 0) === CONCURRENCY, "every load session has exactly one final assistant");

  const sameSession = run.session("same-session");
  await fetch(`${a.baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: sameSession, title: "same session load" }),
  });
  const ssePromise = collectSseUntil(
    b.baseUrl,
    sameSession,
    (events) => events.some((event) => event.event === "agent_status" && event.data.type === "done"),
  );
  await Bun.sleep(100);
  const sameSessionResults = await Promise.all(
    Array.from({ length: SAME_SESSION_CONCURRENCY }, (_, index) => {
      const base = index % 2 ? a.baseUrl : b.baseUrl;
      return fetch(`${base}/agent/default/message?chat_jid=${encodeURIComponent(sameSession)}&wait=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `same-session-${index} quick` }),
      }).then(async (response) => ({ response, body: await response.json() as { outcome?: string } }));
    }),
  );
  const crossReplicaEvents = await ssePromise;
  run.check(crossReplicaEvents.some((event) => event.event === "agent_response"), "SSE on B receives response from A");
  const doneEvents = crossReplicaEvents.filter((event) =>
    event.event === "agent_status" && event.data.type === "done"
  );
  run.check(doneEvents.length === 1, "cross-replica SSE emits turn completion once", String(doneEvents.length));
  run.check(
    sameSessionResults.every(({ response, body }) =>
      response.ok && (body.outcome === "ran" || body.outcome === "queued")
    ),
    "same-session concurrent submissions are serialized or queued",
  );
  await waitFor(async () => {
    const rows = await sql`
      SELECT COUNT(*) FILTER (WHERE role = 'assistant')::int AS assistants,
        COUNT(*) FILTER (WHERE role = 'user')::int AS users
      FROM messages WHERE session_id = ${sameSession}`;
    return Number(rows[0]?.users ?? 0) === SAME_SESSION_CONCURRENCY
      && Number(rows[0]?.assistants ?? 0) === SAME_SESSION_CONCURRENCY;
  }, "same-session queued turns complete");
  const sameSessionRows = await sql`
    SELECT id, role, content FROM messages
    WHERE session_id = ${sameSession}
    ORDER BY id ASC` as Array<{ id: number; role: string; content: string }>;
  const sameUsers = sameSessionRows.filter((row) => row.role === "user");
  const sameAssistants = sameSessionRows.filter((row) => row.role === "assistant");
  run.check(sameUsers.length === SAME_SESSION_CONCURRENCY, "same-session user messages persist exactly once");
  run.check(sameAssistants.length === SAME_SESSION_CONCURRENCY, "same-session assistants complete exactly once");
  run.check(
    sameUsers.every((row, index) => String(row.content).includes(`same-session-${index}`)),
    "same-session user order is preserved",
  );
  const elapsedMs = Date.now() - startedAt;
  run.check(latency.p95 <= MAX_P95_MS, "request p95 remains within threshold", `${latency.p95}ms`);
  run.check(elapsedMs <= MAX_P95_MS * 2, "load runtime remains within threshold", `${elapsedMs}ms`);

  const contextWrite = await fetch(`${a.baseUrl}/agent/default/message?chat_jid=${encodeURIComponent(sameSession)}&wait=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "Remember exactly CONTEXT_A_TO_B_OK and reply quick." }),
  });
  run.check(contextWrite.ok, "context write through replica A succeeds");
  const contextRead = await fetch(`${b.baseUrl}/sessions/${encodeURIComponent(sameSession)}/messages`);
  const contextBody = await contextRead.json() as { messages?: Array<{ content?: string }> };
  run.check(
    contextRead.ok && Boolean(contextBody.messages?.some((message) => message.content?.includes("CONTEXT_A_TO_B_OK"))),
    "context written on A is readable from B",
  );
  const contextSnapshot = await fetch(`${b.baseUrl}/agent/context?chat_jid=${encodeURIComponent(sameSession)}`);
  const snapshotBody = await contextSnapshot.json() as {
    context?: { used?: number | null; total?: number | null };
  };
  run.check(
    contextSnapshot.ok
      && Number(snapshotBody.context?.used ?? 0) > 0
      && Number(snapshotBody.context?.total ?? 0) > 0,
    "context snapshot written on A is readable from B",
  );
  const recall = await fetch(`${b.baseUrl}/agent/default/message?chat_jid=${encodeURIComponent(sameSession)}&wait=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "recall context sentinel" }),
  });
  run.check(recall.ok, "context recall follow-up through B succeeds");
  const recallMessages = await fetch(`${b.baseUrl}/sessions/${encodeURIComponent(sameSession)}/messages`)
    .then((response) => response.json()) as { messages?: Array<{ role?: string; content?: string }> };
  run.check(
    Boolean(recallMessages.messages?.some((message) =>
      message.role === "assistant" && message.content?.includes("CONTEXT_A_TO_B_OK")
    )),
    "mock provider recalls A context when follow-up runs on B",
  );

  console.log(JSON.stringify({
    event: "multi_replica_load_summary",
    concurrency: CONCURRENCY,
    sameSessionConcurrency: SAME_SESSION_CONCURRENCY,
    failures: failures.length,
    failureRate,
    elapsedMs,
    latencyMs: latency,
    thresholds: { maxFailureRate: MAX_FAILURE_RATE, maxP95Ms: MAX_P95_MS },
  }));
} finally {
  try {
    await run.cleanup();
  } finally {
    const report = await run.writeReport();
    console.log(`report: ${report}`);
  }
}

console.log("\nMULTI-REPLICA LOAD E2E PASSED");
