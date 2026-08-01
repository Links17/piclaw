/**
 * Real LLM steer/follow-up acceptance. It never relies on mock-tools.
 */
import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { ensureE2eSession } from "./e2e-session.ts";

const BASE = process.env.CLOUD_E2E_BASE || "http://127.0.0.1:17804";
const run = new RealAcceptance();
const CHAT = run.session("steer");

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function collectSse(sessionId: string, sink: SseEvent[]): AbortController {
  const controller = new AbortController();
  void (async () => {
    const response = await fetch(`${BASE}/sse/stream?chat_jid=${encodeURIComponent(sessionId)}`, {
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

async function waitFor(predicate: () => boolean, name: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`timeout waiting for ${name}`);
}

async function post(path: string, body: unknown): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

console.log(`Real steer/follow-up E2E (${CHAT})`);
let sse: AbortController | null = null;
try {
  await run.preflight(BASE, { requireLlm: true });
  await ensureE2eSession(BASE, CHAT, "real steer acceptance");

  const events: SseEvent[] = [];
  sse = collectSse(CHAT, events);
  await Bun.sleep(300);

  const firstTurn = post(`/agent/default/message?chat_jid=${encodeURIComponent(CHAT)}`, {
    content: "Explain the number 42 in exactly 12 short paragraphs, one sentence per paragraph.",
  });
  await waitFor(
    () => events.some((event) => event.event === "agent_status" && event.data.type === "thinking"),
    "real LLM streaming",
  );

  const queued = await post(`/agent/default/message?chat_jid=${encodeURIComponent(CHAT)}&wait=1`, {
    content: "Replace the final answer with the word STEER_REAL_E2E.",
  });
  run.check(queued.body.outcome === "queued", "follow-up is queued while a real turn is active");
  const rowId = Number((queued.body.user_message as { id?: number } | undefined)?.id);
  run.check(Number.isInteger(rowId) && rowId > 0, "queued follow-up has persisted message id");

  const steer = await post(`/agent/queue-steer?chat_jid=${encodeURIComponent(CHAT)}`, { row_id: rowId });
  run.check(steer.response.ok && steer.body.removed === true, "queue-steer atomically removes queued message");

  await waitFor(
    () => events.some((event) => event.event === "agent_followup_removed" && event.data.row_id === rowId),
    "follow-up removal SSE",
  );
  await waitFor(
    () => events.some((event) => event.event === "agent_steer_queued" && event.data.content === "Replace the final answer with the word STEER_REAL_E2E."),
    "steer applied SSE",
  );
  await waitFor(
    () => events.some((event) => event.event === "agent_response"),
    "real turn completion",
  );

  run.check(
    !events.some((event) => event.event === "agent_followup_consumed" && event.data.row_id === rowId),
    "steered message is not later consumed as a follow-up",
  );
  const queue = await fetch(`${BASE}/agent/queue-state?chat_jid=${encodeURIComponent(CHAT)}`).then((res) => res.json()) as { count?: number };
  run.check(queue.count === 0, "follow-up queue is empty after steering");
  const first = await firstTurn;
  run.check(first.response.ok && first.body.outcome === "ran", "real LLM turn completed");
} finally {
  sse?.abort();
  try {
    await run.cleanup();
  } finally {
    const report = await run.writeReport();
    console.log(`report: ${report}`);
  }
}
