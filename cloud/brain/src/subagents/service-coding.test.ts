import { describe, expect, test } from "bun:test";
import { formatCodingSubagentToolResult } from "./service.ts";
import { usageEntriesForSubagentOutcome } from "./usage-ledger.ts";
import { realtimeKernelUsageEntry } from "./usage-ledger.ts";
import {
  buildCodingWorkerScript,
  SandboxWorkerError,
  parseSandboxUsageReceipts,
} from "./sandbox-worker.ts";

describe("coding subagent gateway", () => {
  test("worker appends a durable receipt after every provider round and preserves usage on errors", () => {
    const script = buildCodingWorkerScript();
    expect(script).toContain("usage_receipts_path");
    expect(script).toContain("os.fsync");
    expect(script).toContain("append_usage_receipt");
    expect(script).not.toContain('"usage": {"inputTokens": 0, "outputTokens": 0');
  });

  test("recovers cumulative usage from durable NDJSON receipts", () => {
    const receipts = parseSandboxUsageReceipts([
      JSON.stringify({ attempt: 1, inputTokens: 10, outputTokens: 2, status: "success" }),
      JSON.stringify({ attempt: 2, inputTokens: 7, outputTokens: 3, reasoningTokens: 1, status: "failed" }),
      "",
    ].join("\n"));
    expect(receipts).toHaveLength(2);
    expect(receipts.reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(17);
    expect(receipts.reduce((sum, entry) => sum + entry.outputTokens, 0)).toBe(5);
  });

  test("structured worker errors preserve second-round usage and timeout status", () => {
    const receipts = parseSandboxUsageReceipts([
      JSON.stringify({ attempt: 1, inputTokens: 10, outputTokens: 2, status: "success" }),
      JSON.stringify({ attempt: 2, inputTokens: 8, outputTokens: 4, status: "success" }),
    ].join("\n"));
    const error = new SandboxWorkerError("PTY disconnected", {
      status: "timed_out",
      receipts,
    });
    expect(error.status).toBe("timed_out");
    expect(error.usage).toMatchObject({ inputTokens: 18, outputTokens: 6 });
    expect(error.receipts.map((receipt) => receipt.attempt)).toEqual([1, 2]);
  });

  test("formatCodingSubagentToolResult returns structured envelope", () => {
    const text = formatCodingSubagentToolResult({
      runId: "run-1",
      status: "completed",
      summary: "Created demo.ino",
      artifacts: ["demo.ino"],
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.run_id).toBe("run-1");
    expect(parsed.status).toBe("completed");
    expect(parsed.artifacts).toEqual(["demo.ino"]);
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  test("keeps worker and fallback usage as separate attempt ledger entries", () => {
    const entries = usageEntriesForSubagentOutcome("run-1", {
      runId: "run-1",
      status: "completed",
      summary: "Recovered through fallback.",
      artifacts: [],
      usage: { inputTokens: 21, outputTokens: 10 },
      usageEntries: [
        {
          invocationId: "run-1",
          attempt: 1,
          stage: "sandbox_worker",
          provider: "openai",
          model: "worker-model",
          inputTokens: 5,
          outputTokens: 2,
          status: "failed",
        },
        {
          invocationId: "run-1",
          attempt: 2,
          stage: "sandbox_worker",
          provider: "openai",
          model: "worker-model",
          inputTokens: 4,
          outputTokens: 2,
          status: "failed",
        },
        {
          invocationId: "run-1",
          attempt: 3,
          stage: "fallback",
          provider: "cloud-kernel",
          model: "fallback-model",
          inputTokens: 12,
          outputTokens: 6,
          status: "success",
          realtimeLedger: true,
        },
      ],
    });

    expect(entries.map((entry) => entry.usageKey)).toEqual([
      "subagent:run-1:run-1:1:sandbox_worker",
      "subagent:run-1:run-1:2:sandbox_worker",
      "subagent:run-1:run-1:3:fallback",
    ]);
    expect(entries.map((entry) => entry.inputTokens)).toEqual([5, 4, 12]);
    expect(entries.map((entry) => entry.status)).toEqual(["failed", "failed", "success"]);
  });

  test("completion only returns entries not already persisted in realtime", () => {
    const entries = usageEntriesForSubagentOutcome("run-2", {
      runId: "run-2",
      status: "completed",
      summary: "done",
      artifacts: [],
      usage: { inputTokens: 13, outputTokens: 5 },
      usageEntries: [
        {
          invocationId: "invocation-2",
          attempt: 7,
          stage: "kernel",
          provider: "cloud-kernel",
          model: "model",
          inputTokens: 10,
          outputTokens: 4,
          status: "success",
          realtimeLedger: true,
        },
        {
          invocationId: "invocation-2",
          attempt: 1,
          stage: "sandbox_worker",
          provider: "openai",
          model: "worker",
          inputTokens: 3,
          outputTokens: 1,
          reasoningTokens: 2,
          cacheReadTokens: 6,
          cacheWriteTokens: 4,
          status: "failed",
        },
      ],
    });
    expect(entries.filter((entry) => !entry.realtimeLedger).map((entry) => entry.stage))
      .toEqual(["sandbox_worker"]);
    expect(entries[1]).toMatchObject({
      reasoningTokens: 2,
      cacheReadTokens: 6,
      cacheWriteTokens: 4,
    });
  });

  test("marks the outer sandbox catch fallback as realtime ledger usage", () => {
    const entry = realtimeKernelUsageEntry("invocation-catch", {
      inputTokens: 21,
      outputTokens: 9,
      reasoningTokens: 3,
      cachedTokens: 8,
      cacheWriteTokens: 2,
    });
    expect(entry).toMatchObject({
      invocationId: "invocation-catch",
      stage: "fallback",
      inputTokens: 21,
      outputTokens: 9,
      reasoningTokens: 3,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
      realtimeLedger: true,
    });
    expect(
      usageEntriesForSubagentOutcome("run-catch", {
        runId: "run-catch",
        status: "completed",
        summary: "fallback",
        artifacts: [],
        usage: { inputTokens: 21, outputTokens: 9 },
        usageEntries: [entry],
      }).filter((usage) => !usage.realtimeLedger),
    ).toEqual([]);
  });
});
