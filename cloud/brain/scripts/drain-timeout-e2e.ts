import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { spawnBrain } from "../src/e2e/spawn-brain.ts";

const BASE_CONFIG = new URL("../../brain.config.llm-e2e.json", import.meta.url).pathname;
const PORT = Number(process.env.CLOUD_DRAIN_TIMEOUT_PORT || 17953);
const run = new RealAcceptance();
const session = run.session("drain-timeout");

try {
  await run.preflight(null, { skipBrain: true });
  const brain = await spawnBrain({
    port: PORT,
    replicaId: `${run.id}-drain-timeout`,
    baseConfigPath: BASE_CONFIG,
    apiKey: "mock-key",
    overrides: {
      sandbox: { enabled: false },
      auth: { required: false },
      openai: { baseUrl: "http://mock.invalid/v1", apiKey: "mock-key", model: "mock-model" },
      limits: { maxDailyTokensPerUser: 5_000_000 },
    },
    env: { CLOUD_LLM_MOCK: "1", CLOUD_DRAIN_TIMEOUT_MS: "100" },
    skipMigrations: true,
  });
  run.trackProcess("drain-timeout", brain.stop);
  await fetch(`${brain.baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: session, title: "timeout" }),
  });
  void fetch(`${brain.baseUrl}/sessions/${encodeURIComponent(session)}/messages?wait=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "slow doomed turn" }),
  }).catch(() => {});
  await Bun.sleep(30);
  process.kill(brain.proc.pid, "SIGTERM");
  const exitCode = await brain.proc.exited;
  run.check(exitCode === 1, "drain timeout exits with failure status", String(exitCode));
} finally {
  try {
    await run.cleanup();
  } finally {
    console.log(`report: ${await run.writeReport()}`);
  }
}

console.log("\nSIGTERM DRAIN TIMEOUT E2E PASSED");
