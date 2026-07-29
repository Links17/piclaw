/**
 * PoC 2 verification — E2B SDK against CubeSandbox.
 *
 *   1. exec + files   — commands.run + files.read/write
 *   2. PTY            — create → sendInput → connect (reattach)
 *   3. pause/resume   — filesystem marker + background process survival
 *   4. artifacts      — archive → kill → new sandbox → restore
 *   5. resume latency — p95 over multiple pause/connect cycles
 */
import { applyE2bEnv, config, missingConfig } from "../src/config.ts";
applyE2bEnv();

import { makeDir, readFile, writeFile } from "../src/fs.ts";
import { getAccessToken } from "../src/auth.ts";
import { archiveFromSandbox, artifactBackend, restoreToSandbox } from "../src/artifacts.ts";
import {
  connectSandbox,
  createSandbox,
  healthCheck,
  killSandbox,
  pauseSandbox,
  ptyCollect,
  teardownClient,
  type Sandbox,
} from "../src/client.ts";

let failures = 0;
const sandboxes: Sandbox[] = [];

function check(condition: boolean, label: string) {
  console.log(`${condition ? "  ✅" : "  ❌"} ${label}`);
  if (!condition) failures += 1;
}

async function track(sbx: Sandbox): Promise<Sandbox> {
  sandboxes.push(sbx);
  return sbx;
}

async function cleanup() {
  for (const sbx of sandboxes) {
    try {
      await killSandbox(sbx);
    } catch {
      // already gone
    }
  }
}

function p95(values: number[]): number {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

// ── preflight ─────────────────────────────────────────────────────────

console.log("PoC 2 — CubeSandbox execution layer");
console.log(`  api:      ${config.apiUrl}`);
console.log(`  domain:   ${config.domain}`);
console.log(`  template: ${config.templateId || "(missing)"}`);
console.log(`  artifacts:${artifactBackend()} → ${config.artifactDir}`);

console.log(`  proxy:    ${config.proxyNodeIp}`);
console.log(`  ops:      ${config.opsUrl} (${config.opsUser})`);

const gaps = missingConfig();
if (gaps.length > 0) {
  console.error(`\nMissing: ${gaps.join(", ")}`);
  console.error("Set CUBE_TEMPLATE_ID and point E2B_API_URL at your CubeAPI.");
  process.exit(2);
}

const health = await healthCheck();
if (!health.ok) {
  console.error("\nCubeAPI health check failed:", health.detail);
  console.error("Start CubeSandbox or set E2B_API_URL / CUBE_API_URL.");
  process.exit(2);
}
console.log("  health:   ok");
await getAccessToken();
console.log("  auth:     ok\n");

try {
  // ── 1. exec + files ─────────────────────────────────────────────────

  console.log("[1] exec + files");
  {
    const sbx = await track(await createSandbox());
    const run = await sbx.commands.run('echo "hello-cube"');
    check(run.stdout.includes("hello-cube"), `commands.run stdout (${run.stdout.trim()})`);

    await writeFile(sbx, "/workspace/poc-marker.txt", "written-by-poc");
    const content = await readFile(sbx, "/workspace/poc-marker.txt");
    check(String(content).includes("written-by-poc"), "files.write/read roundtrip");
  }

  // ── 2. PTY create / attach ──────────────────────────────────────────

  console.log("\n[2] PTY create + reattach");
  {
    const sbx = await track(await createSandbox());
    const decode = (data: string | Uint8Array) =>
      typeof data === "string" ? data : new TextDecoder().decode(data);

    const created: string[] = [];
    const terminal = await sbx.pty.create({
      cols: 80,
      rows: 24,
      timeoutMs: 30_000,
      onData: (data) => created.push(decode(data)),
    });
    await sbx.pty.sendInput(terminal.pid, new TextEncoder().encode("echo PTY_CREATE_OK\n"));
    await Bun.sleep(1500);
    check(created.join("").includes("PTY_CREATE_OK"), "PTY create + echo");

    const reattached: string[] = [];
    const handle = await sbx.pty.connect(terminal.pid, {
      timeoutMs: 30_000,
      onData: (data) => reattached.push(decode(data)),
    });
    await sbx.pty.sendInput(handle.pid, new TextEncoder().encode("echo PTY_REATTACH_OK\n"));
    await Bun.sleep(1500);
    check(reattached.join("").includes("PTY_REATTACH_OK"), "PTY connect() reattach");
    await sbx.pty.sendInput(handle.pid, new TextEncoder().encode("exit\n"));
    await terminal.wait({ timeoutMs: 10_000 }).catch(() => {});
  }

  // ── 3. pause / resume ─────────────────────────────────────────────

  console.log("\n[3] pause/resume — filesystem + background process");
  {
    const sbx = await track(await createSandbox());

    await sbx.commands.run("echo RUNNING > /workspace/bg.marker", { timeoutMs: 30_000 });
    await sbx.commands.run("nohup sleep 300 >/dev/null 2>&1 & echo $! > /workspace/bg.pid", {
      timeoutMs: 30_000,
    });
    await writeFile(sbx, "/workspace/fs.marker", `ts-${Date.now()}`);

    await pauseSandbox(sbx);

    const t0 = Date.now();
    const resumed = await connectSandbox(sbx.sandboxId);
    sandboxes.push(resumed);
    const resumeMs = Date.now() - t0;
    console.log(`  resume latency: ${resumeMs}ms`);

    const fsMarker = await readFile(resumed, "/workspace/fs.marker");
    check(fsMarker.startsWith("ts-"), "filesystem marker survives pause");

    const bgCheck = await resumed.commands.run(
      "test -f /workspace/bg.marker && cat /workspace/bg.marker && kill -0 $(cat /workspace/bg.pid) && echo ALIVE",
      { timeoutMs: 30_000 },
    );
    check(bgCheck.stdout.includes("RUNNING"), "background marker file present");
    check(bgCheck.stdout.includes("ALIVE"), "background process survived pause (memory snapshot)");
  }

  // ── 4. artifacts archive / restore ──────────────────────────────────

  console.log("\n[4] artifacts archive → new sandbox → restore");
  {
    const sbx = await track(await createSandbox());
    const sessionKey = `poc-${Date.now()}`;
    await makeDir(sbx, "/workspace/artifacts/nested");
    await writeFile(sbx, "/workspace/artifacts/note.txt", "artifact-payload");
    await writeFile(sbx, "/workspace/artifacts/nested/data.json", '{"ok":true}');

    await archiveFromSandbox(sbx, sessionKey, [
      "/workspace/artifacts/note.txt",
      "/workspace/artifacts/nested/data.json",
    ]);
    const oldId = sbx.sandboxId;
    await killSandbox(sbx);
    sandboxes.splice(sandboxes.indexOf(sbx), 1);

    const fresh = await track(await createSandbox());
    check(fresh.sandboxId !== oldId, "new sandbox id after kill");

    await restoreToSandbox(fresh, sessionKey);
    const note = await readFile(fresh, "/workspace/artifacts/note.txt");
    const nested = await readFile(fresh, "/workspace/artifacts/nested/data.json");
    check(note === "artifact-payload", "restored note.txt");
    check(nested.includes('"ok":true'), "restored nested/data.json");
  }

  // ── 5. resume latency p95 ───────────────────────────────────────────

  console.log("\n[5] resume latency samples");
  {
    const samples: number[] = [];
    let sbx = await track(await createSandbox());
    for (let i = 0; i < config.resumeSamples; i += 1) {
      await sbx.commands.run(`echo sample-${i}`);
      await pauseSandbox(sbx);
      const t0 = Date.now();
      sbx = await connectSandbox(sbx.sandboxId);
      sandboxes.push(sbx);
      samples.push(Date.now() - t0);
    }
    const p95Ms = p95(samples);
    console.log(`  samples: ${samples.join(", ")}ms → p95=${p95Ms}ms (budget ${config.resumeP95BudgetMs}ms)`);
    check(p95Ms < config.resumeP95BudgetMs, `resume p95 < ${config.resumeP95BudgetMs}ms`);
  }
} finally {
  await cleanup();
  teardownClient();
}

console.log(failures === 0 ? "\nALL SCENARIOS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
