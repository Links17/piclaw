/**
 * Real CubeSandbox terminal protocol acceptance.
 *
 * Requires a running Brain, PostgreSQL, and a CubeSandbox configuration that
 * can create, pause, resume, and attach PTYs. Missing prerequisites exit 2;
 * this script deliberately never skips its terminal checks.
 */
import * as store from "@piclaw-cloud/store";
import { ensureE2eSession } from "./e2e-session.ts";
import { getAccessToken } from "../src/sandbox/auth.ts";
import { connectSandbox, createSandbox, createWorkspaceVolume, healthCheck } from "../src/sandbox/client.ts";
import { applyE2bEnv, missingSandboxConfig } from "../src/sandbox/config.ts";
import { dropLiveSandbox, pauseSessionSandbox } from "../src/sandbox/session.ts";

applyE2bEnv();

const BASE = process.env.CLOUD_E2E_BASE || "http://localhost:7801";
const CHAT = `terminal-reconnect-e2e-${Date.now()}`;
const WS_URL = `${BASE.replace(/^http/, "ws")}/terminal/ws?chat_jid=${encodeURIComponent(CHAT)}`;
const TIMEOUT_MS = Number(process.env.CLOUD_TERMINAL_E2E_TIMEOUT_MS || 90_000);

function failPreflight(message: string): never {
  console.error(`Terminal protocol E2E preflight failed: ${message}`);
  process.exit(2);
}

async function preflight(): Promise<void> {
  const gaps = missingSandboxConfig();
  if (gaps.length > 0) failPreflight(`missing sandbox config: ${gaps.join(", ")}`);

  const health = await healthCheck();
  if (!health.ok) failPreflight(`CubeAPI unreachable: ${String(health.detail)}`);

  try {
    await getAccessToken();
    const volume = await createWorkspaceVolume(`terminal-preflight-${Date.now()}`);
    const disposable = await createSandbox({ volumeId: volume });
    await disposable.kill();
  } catch (error) {
    failPreflight(error instanceof Error ? error.message : String(error));
  }

  try {
    const response = await fetch(`${BASE}/health`);
    if (!response.ok) throw new Error(`Brain health returned ${response.status}`);
  } catch (error) {
    failPreflight(error instanceof Error ? error.message : String(error));
  }
}

async function exchange(command: string, marker: string): Promise<{ pid: number; output: string }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let pid = 0;
    let sent = false;
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out waiting for ${marker}`));
    }, TIMEOUT_MS);

    ws.onmessage = (event) => {
      const text = String(event.data);
      chunks.push(text);
      try {
        const frame = JSON.parse(text) as { type?: string; process_pid?: number };
        if (frame.type === "session" && typeof frame.process_pid === "number") pid = frame.process_pid;
      } catch {
        // Raw terminal output is intentionally supported.
      }
      if (!sent && chunks.join("").includes("[connected]")) {
        sent = true;
        ws.send(JSON.stringify({ type: "input", data: command }));
      }
      if (chunks.join("").includes(marker)) {
        clearTimeout(timer);
        ws.close();
        resolve({ pid, output: chunks.join("") });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("terminal websocket error"));
    };
  });
}

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`FAILED: ${label}`);
  console.log(`  ✅ ${label}`);
}

console.log("Terminal WebSocket + PTY reconnect E2E");
console.log(`  brain: ${BASE}`);
console.log(`  chat:  ${CHAT}`);
await preflight();
console.log("  preflight: Cube create/pause-ready authentication available");

await ensureE2eSession(BASE, CHAT, "terminal reconnect e2e");

console.log("\n[1] close and reopen retains PTY shell state");
const firstMarker = `TERMINAL_MARKER_FIRST_${Date.now()}`;
const first = await exchange(`export PICLAW_TERMINAL_MARKER=${firstMarker}; echo ${firstMarker}\n`, firstMarker);
check(first.pid > 0, `first connection records PID ${first.pid}`);
const firstSession = await store.getSession(CHAT);
check(firstSession?.terminal_pid === first.pid, "first connection persists PID in session");

const reopened = await exchange("echo $PICLAW_TERMINAL_MARKER\n", firstMarker);
check(reopened.pid === first.pid, `reopen reconnects same PID ${first.pid}`);
check(reopened.output.includes(firstMarker), "reopen retains shell marker and prior shell state");

console.log("\n[2] stale PID creates only a new PTY");
const beforeStale = await store.getSession(CHAT);
if (!beforeStale?.sandbox_id || !beforeStale.workspace_volume_id) {
  throw new Error("session did not retain sandbox and workspace volume bindings");
}
const stalePid = 2_147_483_647;
await store.setTerminalPid(CHAT, stalePid);
const afterStale = await exchange("echo STALE_PID_RECOVERED\n", "STALE_PID_RECOVERED");
const staleRecovered = await store.getSession(CHAT);
check(afterStale.pid > 0 && afterStale.pid !== stalePid, "stale PID cleared and new PTY created");
check(staleRecovered?.sandbox_id === beforeStale.sandbox_id, "stale PID recovery preserves sandbox binding");
check(staleRecovered?.workspace_volume_id === beforeStale.workspace_volume_id, "stale PID recovery preserves workspace volume");

console.log("\n[3] pause/resume reopens terminal and preserves marker");
const pausedMarker = `TERMINAL_MARKER_PAUSE_${Date.now()}`;
const beforePause = await exchange(`export PICLAW_PAUSE_MARKER=${pausedMarker}; echo ${pausedMarker}\n`, pausedMarker);
check(await pauseSessionSandbox(CHAT), "sandbox pause succeeded");
const pausedSession = await store.getSession(CHAT);
check(pausedSession?.terminal_pid === null, "sandbox pause clears invalid PTY PID");
dropLiveSandbox(CHAT);

const resumed = await exchange("pwd\n", "/workspace");
check(resumed.output.includes("/workspace"), "terminal reopen resumed sandbox with workspace cwd");
check(resumed.pid > 0 && resumed.pid !== beforePause.pid, "pause/resume creates a fresh PTY");

const finalSession = await store.getSession(CHAT);
if (!finalSession?.sandbox_id) throw new Error("session sandbox binding unexpectedly cleared");
await connectSandbox(finalSession.sandbox_id);
console.log("\n✅ TERMINAL PROTOCOL E2E PASSED");
