/**
 * CubeSandbox client — bridges E2B SDK to this deployment's quirks:
 *
 *   - Auth: dashboard JWT (opsapi login), not a literal e2b_ API key
 *   - Create response: CubeAPI omits envdVersion on POST → poll GET /sandboxes/:id
 *   - Data plane: DNS bypass via proxy-fetch Host header rewrite
 */
import { applyE2bEnv, config, sdkOpts } from "./config.ts";

applyE2bEnv();

import { Sandbox } from "e2b";
import { cubeFetch, getAccessToken } from "./auth.ts";
import { installProxyFetch } from "./proxy-fetch.ts";

export type { Sandbox };

const restoreFetch = installProxyFetch();

interface SandboxInfo {
  sandboxID: string;
  domain?: string;
  envdVersion?: string;
  state?: string;
}

function timeoutSec(): number {
  return Math.ceil(config.sandboxTimeoutMs / 1000);
}

async function getSandboxInfo(sandboxId: string): Promise<SandboxInfo> {
  const res = await cubeFetch(`/sandboxes/${sandboxId}`);
  if (!res.ok) throw new Error(`GET /sandboxes/${sandboxId} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as SandboxInfo;
}

/** Build an E2B Sandbox handle from a live CubeSandbox id. */
async function wrapSandbox(sandboxId: string, info?: SandboxInfo): Promise<Sandbox> {
  const detail = info ?? (await getSandboxInfo(sandboxId));
  const token = await getAccessToken();
  return new Sandbox({
    ...sdkOpts(token),
    sandboxId,
    sandboxDomain: detail.domain ?? config.domain,
    envdVersion: detail.envdVersion ?? "0.5.11",
    envdAccessToken: undefined,
  });
}

export async function healthCheck(): Promise<{ ok: boolean; detail: unknown }> {
  try {
    const res = await fetch(`${config.apiUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, detail: await res.json().catch(() => null) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Create sandbox via CubeAPI REST, then attach E2B SDK data-plane handle. */
export async function createSandbox(): Promise<Sandbox> {
  if (!config.templateId) throw new Error("CUBE_TEMPLATE_ID is required");

  const res = await cubeFetch("/sandboxes", {
    method: "POST",
    body: JSON.stringify({
      templateID: config.templateId,
      timeout: timeoutSec(),
      secure: false,
      allow_internet_access: true,
      autoPause: true,
    }),
  });
  if (!res.ok) throw new Error(`POST /sandboxes → ${res.status}: ${await res.text()}`);

  const created = (await res.json()) as { sandboxID: string };
  return wrapSandbox(created.sandboxID);
}

/** Connect/resume a paused sandbox (CubeAPI has no working /connect — use GET + wrap). */
export async function connectSandbox(sandboxId: string): Promise<Sandbox> {
  const info = await getSandboxInfo(sandboxId);
  if (info.state === "paused") {
    const resume = await cubeFetch(`/sandboxes/${sandboxId}/resume`, { method: "POST", body: "{}" });
    if (!resume.ok && resume.status !== 404) {
      throw new Error(`POST /sandboxes/${sandboxId}/resume → ${resume.status}: ${await resume.text()}`);
    }
    await Bun.sleep(300);
  }
  return wrapSandbox(sandboxId, await getSandboxInfo(sandboxId));
}

export async function pauseSandbox(sandbox: Sandbox): Promise<void> {
  const res = await cubeFetch(`/sandboxes/${sandbox.sandboxId}/pause`, { method: "POST", body: "{}" });
  if (!res.ok) throw new Error(`pause → ${res.status}: ${await res.text()}`);
}

export async function killSandbox(sandbox: Sandbox): Promise<void> {
  await sandbox.kill().catch(async () => {
    await cubeFetch(`/sandboxes/${sandbox.sandboxId}`, { method: "DELETE" });
  });
}

function decodeChunk(data: string | Uint8Array): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

/** Collect PTY output until `needle` appears or timeout. */
export async function ptyCollect(
  sandbox: Sandbox,
  run: (send: (text: string) => Promise<void>) => Promise<void>,
  needle: string,
  timeoutMs = 15000,
): Promise<string> {
  const chunks: string[] = [];
  const terminal = await sandbox.pty.create({
    cols: 80,
    rows: 24,
    timeoutMs: 30_000,
    onData: (data) => chunks.push(decodeChunk(data)),
  });
  const send = async (text: string) => {
    await sandbox.pty.sendInput(terminal.pid, new TextEncoder().encode(text));
  };
  await run(send);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chunks.join("").includes(needle)) break;
    await Bun.sleep(100);
  }
  await sandbox.pty.sendInput(terminal.pid, new TextEncoder().encode("exit\n"));
  await terminal.wait({ timeoutMs: 10_000 }).catch(() => {});
  return chunks.join("");
}

export function teardownClient(): void {
  restoreFetch();
}
