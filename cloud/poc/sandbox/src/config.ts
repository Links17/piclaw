/** PoC 2 configuration — CubeAPI control plane at :13000; ops login remains on :12088. */
export const config = {
  apiUrl: process.env.E2B_API_URL || process.env.CUBE_API_URL || "http://192.168.200.127:13000",
  /** Dummy e2b_ key required by SDK header shape; real auth is JWT accessToken. */
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
  /** CubeProxy node — bypass DNS for *.{domain} data-plane (required off-cluster). */
  proxyNodeIp: process.env.CUBE_PROXY_NODE_IP || "192.168.200.127",
  opsUrl: process.env.CUBE_OPS_URL || "http://192.168.200.127:12088/opsapi/v1",
  opsUser: process.env.CUBE_OPS_USER || process.env.CUBE_ADMIN_USER || "admin",
  opsPassword: process.env.CUBE_OPS_PASSWORD || process.env.CUBE_ADMIN_PASSWORD || "admin",
  resumeSamples: Number(process.env.POC_RESUME_SAMPLES || 3),
  resumeP95BudgetMs: Number(process.env.POC_RESUME_P95_MS || 5000),
  sandboxTimeoutMs: Number(process.env.POC_SANDBOX_TIMEOUT_MS || 5 * 60 * 1000),
};

/** Apply env vars the E2B SDK reads (call before importing `e2b`). */
export function applyE2bEnv(): void {
  process.env.E2B_API_URL = config.apiUrl;
  process.env.E2B_API_KEY = config.apiKey;
  process.env.E2B_DOMAIN = config.domain;
  process.env.E2B_VALIDATE_API_KEY = "false";
  if (config.sandboxUrl) process.env.E2B_SANDBOX_URL = config.sandboxUrl;
  if (process.env.SSL_CERT_FILE && !process.env.NODE_EXTRA_CA_CERTS) {
    process.env.NODE_EXTRA_CA_CERTS = process.env.SSL_CERT_FILE;
  }
}

export function missingConfig(): string[] {
  const gaps: string[] = [];
  if (!config.templateId) gaps.push("CUBE_TEMPLATE_ID");
  if (!config.proxyNodeIp) gaps.push("CUBE_PROXY_NODE_IP");
  return gaps;
}

/** Shared E2B ConnectionConfig opts for CubeSandbox. */
export function sdkOpts(accessToken: string) {
  return {
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    accessToken,
    validateApiKey: false,
    domain: config.domain,
    timeoutMs: config.sandboxTimeoutMs,
    secure: false,
    lifecycle: { onTimeout: "pause" as const },
  };
}
