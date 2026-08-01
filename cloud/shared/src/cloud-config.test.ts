import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getCloudConfig,
  resetCloudConfig,
  setCloudConfigPath,
} from "@piclaw-cloud/shared/cloud-config";

afterEach(() => {
  resetCloudConfig();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("POC_") || key.startsWith("CLOUD_") || key.startsWith("CUBE_") || key.startsWith("E2B_")) {
      delete process.env[key];
    }
  }
});

describe("cloud-config", () => {
  test("file values override env and defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    const path = join(dir, "brain.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        openai: { baseUrl: "http://file.example/v1", apiKey: "file-key", model: "file-model" },
        server: { port: 9999 },
      }),
    );
    process.env.POC_OPENAI_BASE_URL = "http://env.example/v1";
    process.env.POC_PORT = "8888";

    setCloudConfigPath(path);
    const cfg = getCloudConfig();

    expect(cfg.openai.baseUrl).toBe("http://file.example/v1");
    expect(cfg.openai.apiKey).toBe("file-key");
    expect(cfg.server.port).toBe(9999);
  });

  test("a placeholder example API key yields to a real environment key", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    const path = join(dir, "brain.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        openai: {
          baseUrl: "http://example.test/v1",
          apiKey: "sk-your-key-here",
          model: "example-model",
        },
      }),
    );
    process.env.CLOUD_OPENAI_API_KEY = "real-environment-key";

    setCloudConfigPath(path);
    expect(getCloudConfig().openai.apiKey).toBe("real-environment-key");
  });

  test("a real scheduler environment key overrides empty or placeholder file values", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    const path = join(dir, "brain.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        scheduler: {
          serviceKey: "replace-with-a-shared-internal-service-key",
        },
      }),
    );
    process.env.CLOUD_SCHEDULER_SERVICE_KEY = "real-scheduler-key";

    setCloudConfigPath(path);
    expect(getCloudConfig().scheduler.serviceKey).toBe("real-scheduler-key");
  });

  test("a real scheduler environment key overrides an existing real file key", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    const path = join(dir, "brain.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        scheduler: {
          serviceKey: "old-file-scheduler-key",
        },
      }),
    );
    process.env.CLOUD_SCHEDULER_SERVICE_KEY = "rotated-environment-key";

    setCloudConfigPath(path);
    expect(getCloudConfig().scheduler.serviceKey).toBe("rotated-environment-key");
  });

  test("scheduler placeholder key is normalized to unconfigured", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    const path = join(dir, "brain.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        scheduler: {
          serviceKey: "replace-with-a-shared-internal-service-key",
        },
      }),
    );

    setCloudConfigPath(path);
    expect(getCloudConfig().scheduler.serviceKey).toBe("");
  });

  test("scheduler lease and heartbeat durations are configurable from environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    const path = join(dir, "missing.json");
    process.env.CLOUD_SCHEDULER_LEASE_MS = "90000";
    process.env.CLOUD_SCHEDULER_HEARTBEAT_MS = "15000";
    process.env.CLOUD_SCHEDULER_IDLE_PAUSE_LEASE_MS = "45000";

    setCloudConfigPath(path);
    expect(getCloudConfig().scheduler).toMatchObject({
      leaseMs: 90_000,
      heartbeatMs: 15_000,
      idlePauseLeaseMs: 45_000,
    });
  });

  test("rejects non-positive or unsafe scheduler lease configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    const path = join(dir, "missing.json");
    process.env.CLOUD_SCHEDULER_LEASE_MS = "1000";
    process.env.CLOUD_SCHEDULER_HEARTBEAT_MS = "1000";

    setCloudConfigPath(path);
    expect(() => getCloudConfig()).toThrow("scheduler.heartbeatMs must be positive and less than scheduler.leaseMs");
  });

  test("env fills gaps when config file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    const path = join(dir, "missing.json");
    process.env.POC_OPENAI_API_KEY = "env-key";
    process.env.POC_OPENAI_BASE_URL = "http://env.example/v1";

    setCloudConfigPath(path);
    const cfg = getCloudConfig();

    expect(cfg.openai.apiKey).toBe("env-key");
    expect(cfg.openai.baseUrl).toBe("http://env.example/v1");
    expect(cfg.pg.url).toContain("piclaw_cloud_poc");
  });

  test("defaults apply for sandbox and pg when no file or env", () => {
    const dir = mkdtempSync(join(tmpdir(), "piclaw-cloud-config-"));
    setCloudConfigPath(join(dir, "missing.json"));
    const cfg = getCloudConfig();
    expect(cfg.sandbox.apiUrl).toBe("http://192.168.200.127:13000");
    expect(cfg.sandbox.opsUrl).toBe("http://192.168.200.127:12088/opsapi/v1");
    expect(cfg.redis.url).toBe("redis://localhost:26379/5");
    expect(cfg.storage.backend).toBe("local");
    expect(cfg.storage.localDir).toBe("/tmp/piclaw-cloud-objects");
  });
});
