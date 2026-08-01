import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SpawnBrainOptions {
  port: number;
  replicaId: string;
  baseConfigPath: string;
  apiKey: string;
  overrides?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  skipMigrations?: boolean;
}

export interface SpawnedBrain {
  port: number;
  replicaId: string;
  baseUrl: string;
  configPath: string;
  logPath: string;
  proc: ReturnType<typeof Bun.spawn>;
  stop: () => Promise<void>;
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    if (
      value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && existing !== null
      && typeof existing === "object"
      && !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function writeTempBrainConfig(
  baseConfigPath: string,
  overrides: Record<string, unknown>,
  fileName: string,
): Promise<string> {
  const base = await Bun.file(baseConfigPath).json() as Record<string, unknown>;
  const merged = deepMerge(base, overrides);
  const dir = join(tmpdir(), "piclaw-real-acceptance");
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return path;
}

export async function waitForBrainHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await fetch(`${baseUrl}/health`).then((res) => res.ok).catch(() => false);
    if (ok) return;
    await Bun.sleep(200);
  }
  throw new Error(`Brain at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
}

export async function spawnBrain(options: SpawnBrainOptions): Promise<SpawnedBrain> {
  const configPath = await writeTempBrainConfig(
    options.baseConfigPath,
    {
      server: {
        port: options.port,
        replicaId: options.replicaId,
        ...(typeof options.overrides?.server === "object" && options.overrides.server
          ? options.overrides.server as Record<string, unknown>
          : {}),
      },
      ...Object.fromEntries(
        Object.entries(options.overrides ?? {}).filter(([key]) => key !== "server"),
      ),
    },
    `${options.replicaId}-${options.port}.json`,
  );

  const repoRoot = new URL("../../../../", import.meta.url).pathname;
  const logDir = join(tmpdir(), "piclaw-real-acceptance", "logs");
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `${options.replicaId}-${options.port}.log`);
  const logFile = Bun.file(logPath);
  const logWriter = logFile.writer();
  const proc = Bun.spawn({
    cmd: ["bun", "run", "cloud/brain/src/main.ts"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...options.env,
      CLOUD_CONFIG_PATH: configPath,
      CLOUD_OPENAI_API_KEY: options.apiKey,
      ...(options.skipMigrations ? { CLOUD_SKIP_MIGRATIONS: "1" } : {}),
    },
  });
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) logWriter.write(value);
      }
    } catch {
      // process exited
    }
  };
  void Promise.all([pump(proc.stdout), pump(proc.stderr)]).finally(() => {
    try {
      logWriter.end();
    } catch {
      // closed
    }
  });

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const stop = async () => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    await Promise.race([
      proc.exited,
      Bun.sleep(3_000).then(() => {
        try {
          process.kill(proc.pid, "SIGKILL");
        } catch {
          // gone
        }
      }),
    ]);
    await unlink(configPath).catch(() => {});
  };

  try {
    await waitForBrainHealth(baseUrl);
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    port: options.port,
    replicaId: options.replicaId,
    baseUrl,
    configPath,
    logPath,
    proc,
    stop,
  };
}
