/** CubeSandbox / E2B configuration for brain sandbox layer. */
export const sandboxConfig = {
  apiUrl: process.env.E2B_API_URL || process.env.CUBE_API_URL || "http://192.168.200.127:12088",
  apiKey:
    process.env.E2B_API_KEY ||
    process.env.CUBE_API_KEY ||
    "e2b_0000000000000000000000000000000000000000",
  templateId:
    process.env.CUBE_TEMPLATE_ID ||
    process.env.E2B_TEMPLATE_ID ||
    "tpl-474f7cc593f145f0bb4cf232",
  domain: process.env.E2B_DOMAIN || process.env.CUBE_SANDBOX_DOMAIN || "cube.app",
  sandboxUrl: process.env.E2B_SANDBOX_URL || "",
  proxyNodeIp: process.env.CUBE_PROXY_NODE_IP || "192.168.200.127",
  opsUrl: process.env.CUBE_OPS_URL || "http://192.168.200.127:12088/opsapi/v1",
  opsUser: process.env.CUBE_OPS_USER || process.env.CUBE_ADMIN_USER || "admin",
  opsPassword: process.env.CUBE_OPS_PASSWORD || process.env.CUBE_ADMIN_PASSWORD || "admin",
  sandboxTimeoutMs: Number(process.env.POC_SANDBOX_TIMEOUT_MS || 5 * 60 * 1000),
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
  if (!sandboxConfig.templateId) gaps.push("CUBE_TEMPLATE_ID");
  if (!sandboxConfig.proxyNodeIp) gaps.push("CUBE_PROXY_NODE_IP");
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
