import { applyE2bEnv, sandboxConfig, sdkOpts } from "./config.ts";

applyE2bEnv();

import { Sandbox } from "e2b";
import { cubeFetch, getAccessToken } from "./auth.ts";
import { SandboxUnavailableError } from "./errors.ts";
import {
  isRunningState,
  shouldAttemptResume,
  shouldProceedAfterResumeFailure,
} from "./lifecycle.ts";
import { installProxyFetch } from "./proxy-fetch.ts";
import { buildWorkspaceVolumeMounts, createWorkspaceVolume, deleteWorkspaceVolume, volumeNameForSession } from "./volume.ts";

export type { Sandbox };
export { SandboxUnavailableError } from "./errors.ts";
export { createWorkspaceVolume, deleteWorkspaceVolume, volumeNameForSession };

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
  if (res.status === 404) {
    throw new SandboxUnavailableError(sandboxId, "not_found", `GET /sandboxes/${sandboxId} → 404`);
  }
  if (!res.ok) {
    throw new SandboxUnavailableError(
      sandboxId,
      "platform_error",
      `GET /sandboxes/${sandboxId} → ${res.status}: ${await res.text()}`,
    );
  }
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

async function resumeSandbox(sandboxId: string): Promise<void> {
  const resume = await cubeFetch(`/sandboxes/${sandboxId}/resume`, { method: "POST", body: "{}" });
  if (resume.ok || resume.status === 404) {
    await Bun.sleep(300);
    return;
  }

  const body = await resume.text();
  const refreshed = await getSandboxInfo(sandboxId).catch(() => null);
  if (refreshed && shouldProceedAfterResumeFailure(refreshed.state)) {
    return;
  }

  throw new SandboxUnavailableError(
    sandboxId,
    "resume_failed",
    `POST /sandboxes/${sandboxId}/resume → ${resume.status}: ${body}`,
  );
}

async function ensureRunning(sandboxId: string, state?: string): Promise<void> {
  if (shouldAttemptResume(state)) {
    await resumeSandbox(sandboxId);
    return;
  }
  if (isRunningState(state)) return;
  // Unknown states: rely on wrap/connect; platform may use other labels.
}

async function verifySandboxReachable(sbx: Sandbox, sandboxId: string): Promise<void> {
  try {
    const result = await sbx.commands.run("echo ok", { timeoutMs: 15_000 });
    if (result.exitCode === 0 && result.stdout.includes("ok")) return;
    throw new SandboxUnavailableError(
      sandboxId,
      "unreachable",
      `sandbox command probe failed (exit ${result.exitCode})`,
    );
  } catch (error) {
    if (error instanceof SandboxUnavailableError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new SandboxUnavailableError(sandboxId, "unreachable", detail);
  }
}

export async function deleteRemoteSandbox(sandboxId: string): Promise<boolean> {
  const res = await cubeFetch(`/sandboxes/${sandboxId}`, { method: "DELETE" });
  return res.ok || res.status === 404;
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

export async function createSandbox(options: { volumeId: string }): Promise<Sandbox> {
  if (!sandboxConfig.templateId) throw new Error("CUBE_TEMPLATE_ID is required");
  const volumeId = options.volumeId.trim();
  if (!volumeId) throw new Error("CubeSandbox workspace volume is required");

  const body: Record<string, unknown> = {
    templateID: sandboxConfig.templateId,
    timeout: timeoutSec(),
    secure: false,
    allow_internet_access: true,
    // Pause is owned by cloud/scheduler (session idleMs), not Cube autoPause.
    autoPause: false,
  };
  body.volumeMounts = buildWorkspaceVolumeMounts(volumeId);

  const res = await cubeFetch("/sandboxes", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /sandboxes → ${res.status}: ${await res.text()}`);

  const created = (await res.json()) as { sandboxID: string };
  return wrapSandbox(created.sandboxID);
}

export async function connectSandbox(sandboxId: string): Promise<Sandbox> {
  const info = await getSandboxInfo(sandboxId);
  await ensureRunning(sandboxId, info.state);
  const sbx = await wrapSandbox(sandboxId, await getSandboxInfo(sandboxId));
  await verifySandboxReachable(sbx, sandboxId);
  return sbx;
}

export function teardownClient(): void {
  restoreFetch();
}
