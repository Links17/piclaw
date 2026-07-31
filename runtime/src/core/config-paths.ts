import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

/** Workspace-local state directory (config, store, data, certs). */
export const STATE_DIR_NAME = ".seeed";
export const LEGACY_STATE_DIR_NAME = ".piclaw";

export interface RuntimeBootstrapPathOverrides {
  workspace?: string;
  store?: string;
  data?: string;
  runtimeRoot?: string;
}

export interface RuntimeConfigPaths {
  workspaceDir: string;
  storeDir: string;
  dataDir: string;
  configPath: string;
  defaultTlsCertPath: string;
  defaultTlsKeyPath: string;
  hasDefaultTls: boolean;
}

function stateDirPath(workspaceDir: string, segment: string): string {
  return resolve(workspaceDir, STATE_DIR_NAME, segment);
}

/** Rename legacy `.piclaw` to `.seeed` when upgrading existing workspaces. */
export function migrateLegacyStateDirectory(workspaceDir: string): void {
  const legacy = resolve(workspaceDir, LEGACY_STATE_DIR_NAME);
  const next = resolve(workspaceDir, STATE_DIR_NAME);
  if (!existsSync(legacy) || existsSync(next)) return;
  renameSync(legacy, next);
  console.info(`[config] migrated ${LEGACY_STATE_DIR_NAME} -> ${STATE_DIR_NAME} under ${workspaceDir}`);
}

/** Read raw bootstrap-path overrides for sentinels and cache identities. */
export function readRuntimeBootstrapPathOverrides(env: NodeJS.ProcessEnv = process.env): RuntimeBootstrapPathOverrides {
  const read = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed || undefined;
  };
  return {
    workspace: read(env.PICLAW_WORKSPACE),
    store: read(env.PICLAW_STORE),
    data: read(env.PICLAW_DATA),
    runtimeRoot: read(env.PICLAW_RUNTIME_ROOT),
  };
}

/** Resolve bootstrap paths while preserving the CLI-workspace precedence rules. */
export function resolveRuntimeConfigPaths(options: {
  cliWorkspace?: string;
  env?: NodeJS.ProcessEnv;
} = {}): RuntimeConfigPaths {
  const env = options.env ?? process.env;
  const overrides = readRuntimeBootstrapPathOverrides(env);
  const workspaceDir = resolve(options.cliWorkspace || overrides.workspace || "/workspace");
  migrateLegacyStateDirectory(workspaceDir);
  const storeDir = resolve(options.cliWorkspace
    ? stateDirPath(workspaceDir, "store")
    : (overrides.store || stateDirPath(workspaceDir, "store")));
  const dataDir = resolve(options.cliWorkspace
    ? stateDirPath(workspaceDir, "data")
    : (overrides.data || stateDirPath(workspaceDir, "data")));
  const defaultTlsCertPath = stateDirPath(workspaceDir, "certs/sandbox.local.crt");
  const defaultTlsKeyPath = stateDirPath(workspaceDir, "certs/sandbox.local.key");
  return {
    workspaceDir,
    storeDir,
    dataDir,
    configPath: stateDirPath(workspaceDir, "config.json"),
    defaultTlsCertPath,
    defaultTlsKeyPath,
    hasDefaultTls: existsSync(defaultTlsCertPath) && existsSync(defaultTlsKeyPath),
  };
}

/** Resolve a runtime-root override at call time while preserving the caller fallback. */
export function resolveRuntimeRoot(defaultRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = readRuntimeBootstrapPathOverrides(env).runtimeRoot;
  return resolve(override || defaultRoot);
}

/** Resolve the writable config path at call time for isolated workspace tests. */
export function resolveConfigPath(defaultPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const workspace = env.PICLAW_WORKSPACE?.trim();
  return workspace ? stateDirPath(workspace, "config.json") : defaultPath;
}
