/**
 * Brain verification — two replicas, Web SSE vocabulary, mutex/recovery/follow-up.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const A = "http://localhost:7801";
const B = "http://localhost:7802";
const scenarioConfigDir = mkdtempSync(join(tmpdir(), "piclaw-brain-scenario-"));

function loadBaseConfig(): Record<string, unknown> {
  const candidates = [
    join(new URL("../..", import.meta.url).pathname, "brain.config.json"),
    join(new URL("../..", import.meta.url).pathname, "brain.config.example.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    }
  }
  return {};
}

function writeScenarioConfig(port: number, replicaId: string): string {
  const base = loadBaseConfig();
  const server = {
    ...(base.server as Record<string, unknown> | undefined),
    port,
    replicaId,
    inflightGraceMs: 500,
    sweepIntervalMs: 500,
  };
  const openai = { baseUrl: "", apiKey: "", model: "mock" };
  const sandbox = { ...(base.sandbox as Record<string, unknown> | undefined), enabled: false };
  const subagent = {
    ...(base.subagent as Record<string, unknown> | undefined),
    codingWorkerMode: "mock",
  };
  const path = join(scenarioConfigDir, `brain-${port}.json`);
  writeFileSync(
    path,
    JSON.stringify({ ...base, server, openai, sandbox, subagent }, null, 2),
  );
  return path;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function isAgentIdle(event: SseEvent): boolean {
  return event.event === "agent_status" && (event.data.status === "idle" || event.data.type === "done");
}

function isAgentStreaming(event: SseEvent): boolean {
  return (
    event.event === "agent_status" &&
    (event.data.status === "streaming" ||
      event.data.type === "streaming" ||
      event.data.type === "thinking")
  );
}

function startReplica(port: number, id: string) {
  const configPath = writeScenarioConfig(port, id);
  return Bun.spawn({
    cmd: ["bun", "run", "src/main.ts", "--config", configPath],
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      CLOUD_LLM_MOCK: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function waitHealthy(base: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`replica at ${base} did not become healthy`);
}

function collectSse(base: string, sessionId: string, sink: SseEvent[], web = false): AbortController {
  const controller = new AbortController();
  const path = web
    ? `/sse/stream?chat_jid=${encodeURIComponent(sessionId)}`
    : `/sessions/${sessionId}/stream`;
  void (async () => {
    const res = await fetch(`${base}${path}`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (data) sink.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return controller;
}

async function post(base: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(base: string, path: string): Promise<Record<string, unknown>> {
  return (await fetch(base + path)).json();
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 45000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

let failures = 0;
function check(condition: boolean, label: string) {
  console.log(`${condition ? "  ✅" : "  ❌"} ${label}`);
  if (!condition) failures += 1;
}

console.log("brain scenario — starting replicas A(:7801) and B(:7802)...");
let replicaA = startReplica(7801, "A");
const replicaB = startReplica(7802, "B");
await waitHealthy(A);
await waitHealthy(B);

console.log("\n[1] cross-replica Web SSE fan-out");
{
  const { id } = await post(A, "/sessions", { title: "s1" });
  const events: SseEvent[] = [];
  const sse = collectSse(B, String(id), events, true);
  await Bun.sleep(300);
  await post(A, `/sessions/${id}/messages?wait=1`, { content: "hello quick" });
  await waitFor(() => events.some(isAgentIdle), "idle status");
  const deltas = events.filter((e) => e.event === "agent_draft_delta").length;
  check(deltas > 0, `agent_draft_delta via B SSE (${deltas})`);
  check(events.some((e) => e.event === "agent_response"), "agent_response received");
  sse.abort();
}

console.log("\n[2] mutual exclusion & follow-up drain");
{
  const { id } = await post(A, "/sessions", { title: "s2" });
  const events: SseEvent[] = [];
  const sse = collectSse(A, String(id), events);
  await Bun.sleep(300);

  void post(A, `/sessions/${id}/messages`, { content: "medium first" });
  await waitFor(() => events.some(isAgentStreaming), "first turn streaming");

  const second = await post(B, `/sessions/${id}/messages?wait=1`, { content: "second while busy" });
  check(second.outcome === "queued", `second message deferred (outcome=${second.outcome})`);

  await waitFor(
    () => events.filter(isAgentIdle).length >= 2,
    "both turns completed",
  );
  check(events.some((e) => e.event === "agent_followup_consumed"), "follow-up consumed");

  const { messages } = await get(A, `/sessions/${id}/messages`);
  const users = (messages as Array<{ role: string }>).filter((m) => m.role === "user").length;
  const bots = (messages as Array<{ role: string }>).filter((m) => m.role === "assistant").length;
  check(users === 2 && bots === 2, `message counts (user=${users}, assistant=${bots})`);
  sse.abort();
}

console.log("\n[3] kill replica mid-turn → recovery on B");
{
  const { id } = await post(A, "/sessions", { title: "s3" });
  const events: SseEvent[] = [];
  const sse = collectSse(B, String(id), events);
  await Bun.sleep(300);

  void post(A, `/sessions/${id}/messages`, { content: "slow doomed turn" });
  await waitFor(() => events.filter((e) => e.event === "agent_draft_delta").length >= 3, "streaming underway");

  console.log("  killing replica A mid-stream (SIGKILL)...");
  replicaA.kill(9);
  await replicaA.exited;

  await waitFor(
    () =>
      events.some(
        (e) =>
          e.event === "agent_response" &&
          (e.data.recovery === true ||
            (typeof e.data.data === "object" &&
              e.data.data !== null &&
              (e.data.data as { recovery?: boolean }).recovery === true)),
      ),
    "recovered agent_response",
    90000,
  );

  const { messages } = await get(B, `/sessions/${id}/messages`);
  const users = (messages as Array<{ role: string }>).filter((m) => m.role === "user").length;
  const bots = (messages as Array<{ role: string }>).filter((m) => m.role === "assistant").length;
  check(users === 1, `no duplicated user message (user=${users})`);
  check(bots === 1, `one assistant reply (assistant=${bots})`);
  check(
    (messages as Array<{ recovery_marker?: boolean }>).some((m) => m.recovery_marker === true),
    "recovery marker in PG",
  );

  const { cursor, locked } = await get(B, `/sessions/${id}/cursor`);
  check((cursor as { inflight_message_id: null }).inflight_message_id === null, "inflight cleared");
  check(locked === false, "advisory lock released");
  sse.abort();

  replicaA = startReplica(7801, "A2");
  await waitHealthy(A);
}

console.log("\n[4] per-turn DB roundtrips (via cursor after turn)");
{
  const { id } = await post(A, "/sessions", { title: "s4" });
  await post(A, `/sessions/${id}/messages?wait=1`, { content: "count me" });
  const { cursor } = await get(A, `/sessions/${id}/cursor`);
  const inflight = (cursor as { inflight_message_id: unknown }).inflight_message_id;
  check(inflight === null, "turn finished cleanly");
  const { messages } = await get(A, `/sessions/${id}/messages`);
  check((messages as unknown[]).length >= 2, "user+assistant persisted");
}

console.log("\n[5] coding_agent subagent (mock-tools, no sandbox)");
{
  const { id } = await post(A, "/sessions", { title: "s5-coding" });
  await post(A, `/sessions/${id}/messages?wait=1`, { content: "mock-tools:coding_agent" });
  const { messages } = await get(A, `/sessions/${id}/messages`);
  const rows = messages as Array<{ role: string; content: string; content_blocks?: { tool_calls?: Array<{ function?: { name?: string } }> } | null }>;
  const hadCodingTool = rows.some(
    (m) =>
      m.role === "assistant" &&
      (m.content_blocks?.tool_calls?.some((c) => c.function?.name === "coding_agent") ?? false),
  );
  check(hadCodingTool, "main agent invoked coding_agent tool");

  const toolMsg = rows.find((m) => m.role === "tool" && m.content.includes('"status"'));
  check(Boolean(toolMsg?.content.includes("completed")), "coding_agent returned completed status");

  const { runs } = await get(A, `/sessions/${id}/subagents`);
  const subRuns = (runs as Array<{ status: string; agent_type: string }>) ?? [];
  check(
    subRuns.some(
      (r) =>
        (r.agent_type === "coding" || r.agent_type === "general-purpose") && r.status === "completed",
    ),
    "subagent_runs persisted",
  );
}

replicaA.kill();
replicaB.kill();
console.log(failures === 0 ? "\nALL BRAIN SCENARIOS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
