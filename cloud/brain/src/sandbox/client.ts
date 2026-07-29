import { applyE2bEnv, sandboxConfig, sdkOpts } from "./config.ts";

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
  return Math.ceil(sandboxConfig.sandboxTimeoutMs / 1000);
}

async function getSandboxInfo(sandboxId: string): Promise<SandboxInfo> {
  const res = await cubeFetch(`/sandboxes/${sandboxId}`);
  if (!res.ok) throw new Error(`GET /sandboxes/${sandboxId} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as SandboxInfo;
}

async function wrapSandbox(sandboxId: string, info?: SandboxInfo): Promise<Sandbox> {
  const detail = info ?? (await getSandboxInfo(sandboxId));
  const token = await getAccessToken();
  return new Sandbox({
    ...sdkOpts(token),
    sandboxId,
    sandboxDomain: detail.domain ?? sandboxConfig.domain,
    envdVersion: detail.envdVersion ?? "0.5.11",
    envdAccessToken: undefined,
  });
}

export async function healthCheck(): Promise<{ ok: boolean; detail: unknown }> {
  try {
    const res = await fetch(`${sandboxConfig.apiUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, detail: await res.json().catch(() => null) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function createSandbox(): Promise<Sandbox> {
  if (!sandboxConfig.templateId) throw new Error("CUBE_TEMPLATE_ID is required");

  const res = await cubeFetch("/sandboxes", {
    method: "POST",
    body: JSON.stringify({
      templateID: sandboxConfig.templateId,
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

export function teardownClient(): void {
  restoreFetch();
}
