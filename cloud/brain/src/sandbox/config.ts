import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";

const cloud = getCloudConfig();

/** CubeSandbox / E2B configuration for brain sandbox layer. */
export const sandboxConfig = {
  apiUrl: cloud.sandbox.apiUrl,
  apiKey: cloud.sandbox.apiKey,
  templateId: cloud.sandbox.templateId,
  domain: cloud.sandbox.domain,
  sandboxUrl: cloud.sandbox.sandboxUrl,
  proxyNodeIp: cloud.sandbox.proxyNodeIp,
  opsUrl: cloud.sandbox.opsUrl,
  opsUser: cloud.sandbox.opsUser,
  opsPassword: cloud.sandbox.opsPassword,
  sandboxTimeoutMs: cloud.sandbox.timeoutMs,
};

export function applyE2bEnv(): void {
  process.env.E2B_API_URL = sandboxConfig.apiUrl;
  process.env.E2B_API_KEY = sandboxConfig.apiKey;
  process.env.E2B_DOMAIN = sandboxConfig.domain;
  process.env.E2B_VALIDATE_API_KEY = "false";
  if (sandboxConfig.sandboxUrl) process.env.E2B_SANDBOX_URL = sandboxConfig.sandboxUrl;
}

export function missingSandboxConfig(): string[] {
  const gaps: string[] = [];
  if (!sandboxConfig.templateId) gaps.push("sandbox.templateId");
  if (!sandboxConfig.proxyNodeIp) gaps.push("sandbox.proxyNodeIp");
  return gaps;
}

export function sdkOpts(accessToken: string) {
  return {
    apiUrl: sandboxConfig.apiUrl,
    apiKey: sandboxConfig.apiKey,
    accessToken,
    validateApiKey: false,
    domain: sandboxConfig.domain,
    timeoutMs: sandboxConfig.sandboxTimeoutMs,
    secure: false,
    lifecycle: { onTimeout: "pause" as const },
  };
}
