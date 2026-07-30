import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type CodingWorkerMode = "auto" | "sandbox" | "brain" | "mock";

export interface CloudConfig {
  pg: { url: string };
  redis: { url: string };
  server: {
    port: number;
    replicaId: string;
    defaultChatJid: string;
    sweepIntervalMs: number;
    inflightGraceMs: number;
    maxInflightAgeMs: number;
    workspacePollIntervalMs: number;
  };
  openai: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  sandbox: {
    enabled: boolean;
    apiUrl: string;
    apiKey: string;
    templateId: string;
    domain: string;
    sandboxUrl: string;
    proxyNodeIp: string;
    opsUrl: string;
    opsUser: string;
    opsPassword: string;
    timeoutMs: number;
    idleMs: number;
  };
  subagent: {
    codingWorkerMode: CodingWorkerMode;
    timeoutMs: number;
    maxActiveSandboxesPerUser: number;
  };
  limits: {
    maxToolRounds: number;
    maxDailyTokensPerUser: number;
  };
  auth: {
    required: boolean;
    devApiKey: string;
  };
  scheduler: {
    pollMs: number;
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_CONFIG_PATH = join(import.meta.dir, "../../brain.config.json");

let configPathOverride: string | undefined;
let cachedConfig: CloudConfig | undefined;

function defaultConfig(): CloudConfig {
  return {
    pg: { url: "postgres://sensecraft:sensecraft@localhost:25432/piclaw_cloud_poc" },
    redis: { url: "redis://localhost:26379/5" },
    server: {
      port: 7801,
      replicaId: `replica-${process.pid}`,
      defaultChatJid: "web:default",
      sweepIntervalMs: 2000,
      inflightGraceMs: 3000,
      maxInflightAgeMs: 10 * 60 * 1000,
      workspacePollIntervalMs: 60_000,
    },
    openai: {
      baseUrl: "",
      apiKey: "",
      model: "gpt-4o-mini",
    },
    sandbox: {
      enabled: true,
      apiUrl: "http://192.168.200.127:12088",
      apiKey: "e2b_0000000000000000000000000000000000000000",
      templateId: "tpl-474f7cc593f145f0bb4cf232",
      domain: "cube.app",
      sandboxUrl: "",
      proxyNodeIp: "192.168.200.127",
      opsUrl: "http://192.168.200.127:12088/opsapi/v1",
      opsUser: "admin",
      opsPassword: "admin",
      timeoutMs: 5 * 60 * 1000,
      idleMs: 30 * 60 * 1000,
    },
    subagent: {
      codingWorkerMode: "auto",
      timeoutMs: 5 * 60 * 1000,
      maxActiveSandboxesPerUser: 3,
    },
    limits: {
      maxToolRounds: 12,
      maxDailyTokensPerUser: 500_000,
    },
    auth: {
      required: false,
      devApiKey: "",
    },
    scheduler: {
      pollMs: 60_000,
    },
  };
}

function envFirst(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function envNumber(...keys: string[]): number | undefined {
  const raw = envFirst(...keys);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envLayer(): DeepPartial<CloudConfig> {
  const sandboxEnabled = envFirst("CLOUD_SANDBOX_ENABLED");
  const authRequired = envFirst("CLOUD_AUTH_REQUIRED");
  const codingWorkerMode = envFirst("CLOUD_CODING_WORKER_MODE") as CodingWorkerMode | undefined;

  return {
    pg: { url: envFirst("CLOUD_PG_URL", "POC_PG_URL") },
    redis: { url: envFirst("CLOUD_REDIS_URL", "POC_REDIS_URL") },
    server: {
      port: envNumber("CLOUD_PORT", "POC_PORT"),
      replicaId: envFirst("CLOUD_REPLICA_ID", "POC_REPLICA_ID"),
      defaultChatJid: envFirst("CLOUD_DEFAULT_CHAT_JID"),
      sweepIntervalMs: envNumber("CLOUD_SWEEP_INTERVAL_MS", "POC_SWEEP_INTERVAL_MS"),
      inflightGraceMs: envNumber("CLOUD_INFLIGHT_GRACE_MS", "POC_INFLIGHT_GRACE_MS"),
      maxInflightAgeMs: envNumber("CLOUD_MAX_INFLIGHT_AGE_MS", "POC_MAX_INFLIGHT_AGE_MS"),
      workspacePollIntervalMs: envNumber("CLOUD_WORKSPACE_POLL_MS"),
    },
    openai: {
      baseUrl: envFirst("CLOUD_OPENAI_BASE_URL", "POC_OPENAI_BASE_URL"),
      apiKey: envFirst("CLOUD_OPENAI_API_KEY", "POC_OPENAI_API_KEY"),
      model: envFirst("CLOUD_OPENAI_MODEL", "POC_OPENAI_MODEL"),
    },
    sandbox: {
      enabled: sandboxEnabled !== undefined ? sandboxEnabled !== "0" : undefined,
      apiUrl: envFirst("E2B_API_URL", "CUBE_API_URL", "CLOUD_SANDBOX_API_URL"),
      apiKey: envFirst("E2B_API_KEY", "CUBE_API_KEY", "CLOUD_SANDBOX_API_KEY"),
      templateId: envFirst("CUBE_TEMPLATE_ID", "E2B_TEMPLATE_ID"),
      domain: envFirst("E2B_DOMAIN", "CUBE_SANDBOX_DOMAIN"),
      sandboxUrl: envFirst("E2B_SANDBOX_URL"),
      proxyNodeIp: envFirst("CUBE_PROXY_NODE_IP"),
      opsUrl: envFirst("CUBE_OPS_URL", "CLOUD_SANDBOX_OPS_URL"),
      opsUser: envFirst("CUBE_OPS_USER", "CUBE_ADMIN_USER", "CLOUD_SANDBOX_OPS_USER"),
      opsPassword: envFirst("CUBE_OPS_PASSWORD", "CUBE_ADMIN_PASSWORD", "CLOUD_SANDBOX_OPS_PASSWORD"),
      timeoutMs: envNumber("POC_SANDBOX_TIMEOUT_MS"),
      idleMs: envNumber("CLOUD_SANDBOX_IDLE_MS"),
    },
    subagent: {
      codingWorkerMode,
      timeoutMs: envNumber("CLOUD_SUBAGENT_TIMEOUT_MS"),
      maxActiveSandboxesPerUser: envNumber("CLOUD_MAX_ACTIVE_SANDBOXES"),
    },
    limits: {
      maxToolRounds: envNumber("CLOUD_MAX_TOOL_ROUNDS"),
      maxDailyTokensPerUser: envNumber("CLOUD_MAX_DAILY_TOKENS"),
    },
    auth: {
      required: authRequired !== undefined ? authRequired === "1" : undefined,
      devApiKey: envFirst("CLOUD_DEV_API_KEY"),
    },
    scheduler: {
      pollMs: envNumber("CLOUD_SCHEDULER_POLL_MS"),
    },
  };
}

function deepMerge<T>(base: T, ...layers: Array<DeepPartial<T>>): T {
  const result = { ...base } as T;
  for (const layer of layers) {
    for (const key of Object.keys(layer) as Array<keyof T>) {
      const value = layer[key];
      if (value === undefined) continue;
      const existing = result[key];
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        result[key] = deepMerge(existing, value as DeepPartial<typeof existing>) as T[keyof T];
      } else {
        result[key] = value as T[keyof T];
      }
    }
  }
  return result;
}

function readFileLayer(path: string): DeepPartial<CloudConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DeepPartial<CloudConfig>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse cloud config at ${path}: ${message}`);
  }
}

function resolveConfigPath(): string {
  return configPathOverride ?? DEFAULT_CONFIG_PATH;
}

function loadCloudConfig(): CloudConfig {
  const path = resolveConfigPath();
  const fileExists = existsSync(path);
  const fileLayer = readFileLayer(path);

  if (!fileExists) {
    const env = envLayer();
    const hasEnvPg = Boolean(env.pg?.url);
    const hasEnvRedis = Boolean(env.redis?.url);
    if (!hasEnvPg && !hasEnvRedis) {
      console.warn(
        `[cloud-config] ${path} not found — using defaults. Copy cloud/brain.config.example.json to cloud/brain.config.json for local dev.`,
      );
    } else {
      console.warn(`[cloud-config] ${path} not found — using environment overrides + defaults.`);
    }
  }

  return deepMerge(defaultConfig(), envLayer(), fileLayer);
}

/** Override config file path (call before first getCloudConfig()). */
export function setCloudConfigPath(path: string): void {
  configPathOverride = path;
  cachedConfig = undefined;
}

/** Reset cached config — for tests. */
export function resetCloudConfig(): void {
  configPathOverride = undefined;
  cachedConfig = undefined;
}

/** Parse `--config=/path` or `--config /path` from argv. */
export function parseConfigArgFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
    if (arg === "--config" && argv[i + 1]) return argv[i + 1];
  }
  return undefined;
}

export function getCloudConfig(): CloudConfig {
  if (!cachedConfig) cachedConfig = loadCloudConfig();
  return cachedConfig;
}
