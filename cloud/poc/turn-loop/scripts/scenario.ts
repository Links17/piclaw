/**
 * PoC 1 verification scenarios. Spawns two replicas (A:7801, B:7802) and:
 *
 *   1. cross-replica SSE   — subscribe on B, run turn via A, expect deltas on B
 *   2. mutex + follow-up   — slow turn via A, second message via B queues,
 *                            then auto-drains after the first turn ends
 *   3. kill recovery       — slow turn on A, SIGKILL A mid-stream, expect B's
 *                            sweep to re-run the turn (recovery marker, no
 *                            lost/duplicated messages)
 *   4. roundtrip report    — print db_roundtrips + duration per turn
 */
const A = "http://localhost:7801";
const B = "http://localhost:7802";

interface SseEvent {
  event: string;
  data: any;
}

function startReplica(port: number, id: string) {
  return Bun.spawn({
    cmd: ["bun", "run", "src/main.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, POC_PORT: String(port), POC_REPLICA_ID: id },
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function waitHealthy(base: string, timeoutMs = 10000): Promise<void> {
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

/** Collect SSE events from a stream into an array (until aborted). */
function collectSse(base: string, sessionId: string, sink: SseEvent[]): AbortController {
  const controller = new AbortController();
  void (async () => {
    const res = await fetch(`${base}/sessions/${sessionId}/stream`, { signal: controller.signal });
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

async function post(base: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(base: string, path: string): Promise<any> {
  return (await fetch(base + path)).json();
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30000): Promise<void> {
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

// ── boot ──────────────────────────────────────────────────────────────

console.log("starting replicas A(:7801) and B(:7802)...");
let replicaA = startReplica(7801, "A");
const replicaB = startReplica(7802, "B");
await waitHealthy(A);
await waitHealthy(B);

// ── scenario 1: cross-replica SSE ─────────────────────────────────────

console.log("\n[1] cross-replica SSE fan-out");
{
  const { id } = await post(A, "/sessions", { title: "s1" });
  const events: SseEvent[] = [];
  const sse = collectSse(B, id, events); // subscribe on B
  await Bun.sleep(300);
  await post(A, `/sessions/${id}/messages?wait=1`, { content: "hello quick" }); // run on A
  await waitFor(() => events.some((e) => e.event === "turn_done"), "turn_done on B");
  const deltas = events.filter((e) => e.event === "delta").length;
  check(deltas > 0, `deltas received via B's SSE (${deltas})`);
  check(events.some((e) => e.event === "message"), "final message event received");
  sse.abort();
}

// ── scenario 2: mutex + follow-up queue ───────────────────────────────

console.log("\n[2] mutual exclusion & follow-up drain");
{
  const { id } = await post(A, "/sessions", { title: "s2" });
  const events: SseEvent[] = [];
  const sse = collectSse(A, id, events);
  await Bun.sleep(300);

  // Slow turn (~10s at 40x500ms → we use medium 3s to keep the suite fast? no: slow gives margin)
  void post(A, `/sessions/${id}/messages`, { content: "medium first" });
  await waitFor(() => events.some((e) => e.event === "turn_started"), "first turn started");

  const second = await post(B, `/sessions/${id}/messages?wait=1`, { content: "second while busy" });
  check(second.outcome === "queued", `second message deferred (outcome=${second.outcome})`);

  await waitFor(
    () => events.filter((e) => e.event === "turn_done").length >= 2,
    "both turns completed",
  );
  const consumed = events.some((e) => e.event === "followup_consumed");
  check(consumed, "follow-up consumed after first turn");

  const { messages } = await get(A, `/sessions/${id}/messages`);
  const users = messages.filter((m: any) => m.role === "user").length;
  const bots = messages.filter((m: any) => m.role === "assistant").length;
  check(users === 2 && bots === 2, `message counts correct (user=${users}, assistant=${bots})`);

  const startOrder = events
    .filter((e) => e.event === "turn_started" || e.event === "turn_done")
    .map((e) => e.event);
  const serialized = startOrder.join(",") === "turn_started,turn_done,turn_started,turn_done";
  check(serialized, `turns strictly serialized (${startOrder.join(" → ")})`);
  sse.abort();
}

// ── scenario 3: kill mid-turn, cross-replica recovery ─────────────────

console.log("\n[3] kill replica mid-turn → recovery on the other replica");
{
  const { id } = await post(A, "/sessions", { title: "s3" });
  const events: SseEvent[] = [];
  const sse = collectSse(B, id, events);
  await Bun.sleep(300);

  void post(A, `/sessions/${id}/messages`, { content: "slow doomed turn" });
  await waitFor(() => events.filter((e) => e.event === "delta").length >= 3, "streaming underway");

  console.log("  killing replica A mid-stream (SIGKILL)...");
  replicaA.kill(9);
  await replicaA.exited;

  await waitFor(
    () => events.some((e) => e.event === "recovery" && e.data.action === "retried"),
    "B announces recovery retry",
    30000,
  );
  await waitFor(
    () => events.some((e) => e.event === "message" && e.data.recovery === true),
    "recovered turn produced a final message",
    60000,
  );

  const { messages } = await get(B, `/sessions/${id}/messages`);
  const users = messages.filter((m: any) => m.role === "user").length;
  const bots = messages.filter((m: any) => m.role === "assistant").length;
  check(users === 1, `no duplicated user message (user=${users})`);
  check(bots === 1, `exactly one assistant reply after recovery (assistant=${bots})`);
  check(
    messages.some((m: any) => m.recovery_marker === true),
    "assistant reply carries recovery marker",
  );

  const { cursor, locked } = await get(B, `/sessions/${id}/cursor`);
  check(cursor.inflight_message_id === null, "inflight marker cleared");
  check(locked === false, "advisory lock released");
  sse.abort();

  replicaA = startReplica(7801, "A2");
  await waitHealthy(A);
}

// ── scenario 4: roundtrip report ──────────────────────────────────────

console.log("\n[4] per-turn DB roundtrips");
{
  const { id } = await post(A, "/sessions", { title: "s4" });
  const events: SseEvent[] = [];
  const sse = collectSse(A, id, events);
  await Bun.sleep(300);
  await post(A, `/sessions/${id}/messages?wait=1`, { content: "count me" });
  await waitFor(() => events.some((e) => e.event === "turn_done"), "turn done");
  const done = events.find((e) => e.event === "turn_done")!;
  console.log(`  db_roundtrips=${done.data.dbRoundtrips} duration=${done.data.durationMs}ms`);
  check(done.data.dbRoundtrips <= 10, `roundtrips within budget (${done.data.dbRoundtrips} ≤ 10)`);
  sse.abort();
}

// ── teardown ──────────────────────────────────────────────────────────

replicaA.kill();
replicaB.kill();
console.log(failures === 0 ? "\nALL SCENARIOS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
