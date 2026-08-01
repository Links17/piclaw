import { describe, expect, test } from "bun:test";
import {
  compactionCapabilityHints,
  normalizeCompactionSettings,
} from "./compaction.ts";

describe("compaction settings helpers", () => {
  test("reports selective as the active cloud method without an unavailable warning", () => {
    const normalized = normalizeCompactionSettings({
      smartCompactionMethod: "pipelined",
      remoteCompactionEnabled: true,
      toolResultSemanticSummaryEnabled: true,
    });
    const hints = compactionCapabilityHints(normalized);

    expect(normalized.smartCompactionMethod).toBe("selective");
    expect(hints.selective).toBe("cloud_selective");
    expect(hints.pipelined).toBe("disabled");
    expect(hints.remote).toBe("disabled");
    expect(hints.semantic).toBe("disabled");
  });
});
