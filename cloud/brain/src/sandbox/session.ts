import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { connectSandbox, createSandbox, type Sandbox } from "./client.ts";

const live = new Map<string, Sandbox>();

/** Lazy-create or resume the sandbox bound to a session. */
export async function ensureSandbox(sessionId: string): Promise<Sandbox> {
  if (!config.sandboxEnabled) {
    throw new Error("sandbox disabled (CLOUD_SANDBOX_ENABLED=0)");
  }
  const cached = live.get(sessionId);
  if (cached) return cached;

  const session = await store.getSession(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);

  const sbx = session.sandbox_id
    ? await connectSandbox(session.sandbox_id)
    : await createSandbox();

  if (!session.sandbox_id) {
    await store.setSandboxId(sessionId, sbx.sandboxId);
  }
  live.set(sessionId, sbx);
  return sbx;
}

export async function runBash(sessionId: string, command: string): Promise<string> {
  const sbx = await ensureSandbox(sessionId);
  const result = await sbx.commands.run(command, { timeoutMs: 120_000 });
  const parts = [`$ ${command}`];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) parts.push(result.stderr.trimEnd());
  parts.push(`(exit ${result.exitCode})`);
  return parts.join("\n");
}

/** PTY attach for terminal WebSocket — returns pid + sandbox handle. */
export async function createTerminal(sessionId: string): Promise<{ sandbox: Sandbox; pid: number }> {
  const sbx = await ensureSandbox(sessionId);
  const terminal = await sbx.pty.create({ cols: 80, rows: 24, timeoutMs: 60_000, onData: () => {} });
  return { sandbox: sbx, pid: terminal.pid };
}

export function getLiveSandbox(sessionId: string): Sandbox | undefined {
  return live.get(sessionId);
}
