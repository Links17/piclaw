/**
 * Real dual-replica LLM recovery acceptance.
 *
 * Spawns Brain A + Brain B against shared PostgreSQL/Redis, starts a long
 * real LLM turn on A, kills A while the turn is inflight, and asserts B's
 * recovery sweep retries exactly once before draining a queued follow-up.
 */
import { sql } from "@piclaw-cloud/store/db";
import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { spawnBrain } from "../src/e2e/spawn-brain.ts";
import { ensureE2eSession } from "./e2e-session.ts";

const BASE_CONFIG = new URL("../../brain.config.llm-e2e.json", import.meta.url).pathname;
const API_KEY = process.env.CLOUD_OPENAI_API_KEY
  || await Bun.file(new URL("../../brain.config.json", import.meta.url).pathname)
    .json()
    .then((cfg: { openai?: { apiKey?: string } }) => cfg.openai?.apiKey ?? "");

const PORT_A = Number(process.env.CLOUD_RECOVERY_PORT_A || 17911);
const PORT_B = Number(process.env.CLOUD_RECOVERY_PORT_B || 17912);

const run = new RealAcceptance();
const CHAT = run.session("recovery");

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function collectSse(base: string, sessionId: string, sink: SseEvent[]): AbortController {
  const controller = new AbortController();
  void (async () => {
    const response = await fetch(`${base}/sse/stream?chat_jid=${encodeURIComponent(sessionId)}`, {
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE connection failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event = block.match(/^event: (.+)$/m)?.[1] ?? "message";
          const raw = block.match(/^data: (.+)$/m)?.[1];
          if (raw) sink.push({ event, data: JSON.parse(raw) as Record<string, unknown> });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return controller;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, name: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`timeout waiting for ${name}`);
}

async function getInflight(): Promise<number | null> {
  const rows = await sql`
    SELECT inflight_message_id
    FROM session_cursors
    WHERE session_id = ${CHAT}`;
  const value = rows[0]?.inflight_message_id;
  return value == null ? null : Number(value);
}

async function getMessages(): Promise<Array<{ id: number; role: string; content: string; recovery_marker: boolean }>> {
  const rows = await sql`
    SELECT id, role, content, recovery_marker
    FROM messages
    WHERE session_id = ${CHAT}
    ORDER BY id ASC`;
  return rows as Array<{ id: number; role: string; content: string; recovery_marker: boolean }>;
}

if (!API_KEY || API_KEY === "sk-your-key-here") {
  console.error("Missing CLOUD_OPENAI_API_KEY / brain.config.json openai.apiKey");
  process.exit(2);
}

console.log(`Real dual-replica recovery E2E (${CHAT})`);
console.log(`  ports: A=${PORT_A} B=${PORT_B}`);

let sse: AbortController | null = null;
try {
  await run.preflight(null, { requireLlm: true, skipBrain: true });

  const replicaA = await spawnBrain({
    port: PORT_A,
    replicaId: `${run.id}-A`,
    baseConfigPath: BASE_CONFIG,
    apiKey: API_KEY,
    overrides: {
      server: {
        sweepIntervalMs: 500,
        inflightGraceMs: 500,
        maxInflightAgeMs: 10 * 60 * 1000,
      },
      sandbox: { enabled: false },
      limits: { maxDailyTokensPerUser: 5_000_000 },
    },
  });
  run.trackProcess("replica-A", replicaA.stop);

  const replicaB = await spawnBrain({
    port: PORT_B,
    replicaId: `${run.id}-B`,
    baseConfigPath: BASE_CONFIG,
    apiKey: API_KEY,
    overrides: {
      server: {
        sweepIntervalMs: 500,
        inflightGraceMs: 500,
        maxInflightAgeMs: 10 * 60 * 1000,
      },
      sandbox: { enabled: false },
      limits: { maxDailyTokensPerUser: 5_000_000 },
    },
    skipMigrations: true,
  });
  run.trackProcess("replica-B", replicaB.stop);

  await ensureE2eSession(replicaA.baseUrl, CHAT, "real dual-replica recovery");

  const events: SseEvent[] = [];
  // Subscribe on B so the SSE survives A's crash (events travel via Redis).
  sse = collectSse(replicaB.baseUrl, CHAT, events);
  await Bun.sleep(400);

  const longPrompt =
    "Write exactly 20 short numbered sentences about the color blue. "
    + "One sentence per line. Do not stop before sentence 20.";

  const firstTurn = fetch(
    `${replicaA.baseUrl}/agent/default/message?chat_jid=${encodeURIComponent(CHAT)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: longPrompt }),
    },
  ).catch((error) => {
    // Expected once replica A is killed mid-turn.
    return error;
  });

  await waitFor(async () => {
    const inflight = await getInflight();
    const streaming = events.some((event) =>
      event.event === "agent_draft_delta"
      || (event.event === "agent_status" && event.data.type === "thinking")
    );
    return inflight != null || streaming;
  }, "real LLM turn becomes inflight/streaming on replica A", 90_000);

  const inflightBeforeKill = await getInflight();
  run.check(inflightBeforeKill != null && inflightBeforeKill > 0, "inflight cursor persisted before crash", String(inflightBeforeKill));

  const followup = await fetch(
    `${replicaA.baseUrl}/agent/default/message?chat_jid=${encodeURIComponent(CHAT)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "After recovery, reply with exactly RECOVERY_FOLLOWUP_OK." }),
    },
  );
  const followupBody = await followup.json() as { outcome?: string; user_message?: { id?: number } };
  run.check(followupBody.outcome === "queued", "follow-up queued while replica A holds the turn");
  const followupId = Number(followupBody.user_message?.id);
  run.check(Number.isInteger(followupId) && followupId > 0, "queued follow-up has message id");

  // Ensure A has not already finished (which would make the crash test meaningless).
  run.check((await getInflight()) === inflightBeforeKill, "turn still inflight immediately before crash");

  console.log(`  killing replica A (pid ${replicaA.proc.pid}) while turn is inflight`);
  process.kill(replicaA.proc.pid, "SIGKILL");
  await replicaA.proc.exited;

  await waitFor(
    () => events.some((event) =>
      event.event === "agent_recovery"
      && event.data.action === "retried"
      && event.data.replica === replicaB.replicaId
    ),
    "replica B recovery SSE",
    90_000,
  );
  run.check(true, "replica B published recovery retried SSE");

  await waitFor(async () => {
    const assistants = (await getMessages()).filter((row) => row.role === "assistant" && row.recovery_marker);
    return assistants.length === 1;
  }, "recovered assistant persisted with recovery_marker", 180_000);
  run.check(true, "recovered assistant response persisted");

  await waitFor(
    () => events.some((event) =>
      event.event === "agent_followup_consumed" && Number(event.data.row_id) === followupId
    ),
    "follow-up consumed after recovery",
    180_000,
  );
  run.check(true, "follow-up consumed after recovery");

  // followup_consumed is emitted before the follow-up turn finishes; wait for the reply.
  await waitFor(async () => {
    const rows = await getMessages();
    const assistants = rows.filter((row) => row.role === "assistant");
    const inflight = await getInflight();
    const failed = events.some((event) => event.event === "agent_status" && event.data.type === "error");
    if (failed) {
      throw new Error(`follow-up turn failed: ${JSON.stringify(events.filter((e) => e.event === "agent_status").slice(-3))}`);
    }
    return assistants.length >= 2 && inflight == null;
  }, "follow-up assistant completed and inflight cleared", 240_000);

  const messages = await getMessages();
  const users = messages.filter((row) => row.role === "user");
  const assistants = messages.filter((row) => row.role === "assistant");
  const recovered = assistants.filter((row) => row.recovery_marker);
  const followupConsumedCount = events.filter((event) =>
    event.event === "agent_followup_consumed" && event.data.row_id === followupId
  ).length;

  run.check(users.length === 2, "user messages preserved after crash", String(users.length));
  run.check(assistants.length === 2, "exactly one assistant reply per user turn", String(assistants.length));
  run.check(recovered.length === 1, "recovered turn writes one recovery-marked assistant reply");
  run.check(followupConsumedCount === 1, "queued follow-up consumed exactly once");
  run.check(
    assistants.some((row) => !row.recovery_marker && row.content.trim().length > 0),
    "follow-up reply completed after recovery",
  );

  await firstTurn;
  run.check(true, "dual-replica recovery completed with real LLM");
} finally {
  sse?.abort();
  try {
    await run.cleanup();
  } finally {
    const report = await run.writeReport();
    console.log(`report: ${report}`);
  }
}

console.log("\nREAL DUAL-REPLICA RECOVERY E2E PASSED");
process.exit(0);
