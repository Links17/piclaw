import { describe, expect, test } from "bun:test";
import { writeTempBrainConfig } from "./spawn-brain.ts";

describe("spawn-brain config helper", () => {
  test("writes a temp config that overrides server and limits", async () => {
    const path = await writeTempBrainConfig(
      new URL("../../../brain.config.example.json", import.meta.url).pathname,
      {
        server: {
          port: 17999,
          replicaId: "unit-test-replica",
          sweepIntervalMs: 500,
          inflightGraceMs: 250,
        },
        limits: { maxDailyTokensPerUser: 42 },
      },
      `unit-${Date.now()}.json`,
    );
    const parsed = await Bun.file(path).json() as {
      server: { port: number; replicaId: string; sweepIntervalMs: number };
      limits: { maxDailyTokensPerUser: number };
    };
    expect(parsed.server.port).toBe(17999);
    expect(parsed.server.replicaId).toBe("unit-test-replica");
    expect(parsed.server.sweepIntervalMs).toBe(500);
    expect(parsed.limits.maxDailyTokensPerUser).toBe(42);
  });
});
