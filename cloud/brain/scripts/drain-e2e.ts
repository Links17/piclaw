import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { spawnBrain } from "../src/e2e/spawn-brain.ts";

const BASE_CONFIG = new URL("../../brain.config.llm-e2e.json", import.meta.url).pathname;
const PORT_A = Number(process.env.CLOUD_DRAIN_PORT_A || 17951);
const PORT_B = Number(process.env.CLOUD_DRAIN_PORT_B || 17952);
const run = new RealAcceptance();
const session = run.session("drain");

async function waitFor(predicate: () => Promise<boolean>, name: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${name}`);
}

try {
  await run.preflight(null, { skipBrain: true });
  const common = {
    baseConfigPath: BASE_CONFIG,
    apiKey: "mock-key",
    overrides: {
      sandbox: { enabled: false },
      auth: { required: false },
      openai: { baseUrl: "http://mock.invalid/v1", apiKey: "mock-key", model: "mock-model" },
      limits: { maxDailyTokensPerUser: 5_000_000 },
    },
    env: { CLOUD_LLM_MOCK: "1", CLOUD_DRAIN_TIMEOUT_MS: "10000" },
  };
  const a = await spawnBrain({ ...common, port: PORT_A, replicaId: `${run.id}-drain-a` });
  run.trackProcess("drain-a", a.stop);
  const b = await spawnBrain({ ...common, port: PORT_B, replicaId: `${run.id}-drain-b`, skipMigrations: true });
  run.trackProcess("drain-b", b.stop);

  await fetch(`${a.baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: session, title: "drain" }),
  });
  const longTurn = fetch(`${a.baseUrl}/sessions/${encodeURIComponent(session)}/messages?wait=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "drain controlled turn" }),
  });
  await waitFor(
    () => fetch(`${a.baseUrl}/health`)
      .then(async (response) => {
        const body = await response.json() as { activeOperations?: Record<string, number> };
        return body.activeOperations?.turn === 1;
      })
      .catch(() => false),
    "replica A active turn",
  );
  const signalAt = Date.now();
  process.kill(a.proc.pid, "SIGTERM");

  await waitFor(
    () => fetch(`${a.baseUrl}/ready`).then((response) => response.status === 503).catch(() => false),
    "replica A readiness failure",
  );
  run.check((await fetch(`${a.baseUrl}/live`)).status === 200, "draining replica remains live");

  const rejected = await fetch(`${a.baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: run.session("rejected"), title: "rejected" }),
  });
  run.check(rejected.status === 503, "new work is rejected by draining replica");
  run.check(rejected.headers.get("Retry-After") === "5", "drain rejection includes Retry-After");

  const servedByB = await fetch(`${b.baseUrl}/sessions/${encodeURIComponent(session)}/messages`);
  run.check(servedByB.ok, "replica B continues serving observations");

  const longTurnResponse = await longTurn;
  run.check(longTurnResponse.ok, "started operation completes during drain");
  const exitCode = await a.proc.exited;
  run.check(exitCode === 0, "replica A exits cleanly after operation completion", String(exitCode));
  const persisted = await fetch(`${b.baseUrl}/sessions/${encodeURIComponent(session)}/messages`);
  const persistedBody = await persisted.json() as { messages?: Array<{ role?: string }> };
  run.check(
    persisted.ok && Boolean(persistedBody.messages?.some((message) => message.role === "assistant")),
    "started long turn persists completion before clean exit",
  );
  run.check(Date.now() - signalAt < 10_000, "clean drain exits before timeout");
} finally {
  try {
    await run.cleanup();
  } finally {
    const report = await run.writeReport();
    console.log(`report: ${report}`);
  }
}

console.log("\nSIGTERM DRAIN E2E PASSED");
