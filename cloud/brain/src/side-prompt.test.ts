import { beforeEach, describe, expect, mock, test } from "bun:test";

const getSession = mock(async () => ({ id: "session-1", user_id: "user-1" }));
const getSessionMode = mock(async () => "agent");
const getSessionPlanText = mock(async () => null);
const checkQuota = mock<() => Promise<{
  ok: boolean;
  reason?: "daily_token_limit";
  dailyTokens: number;
}>>(async () => ({ ok: true, dailyTokens: 0 }));
const logTokenUsage = mock(async () => true);
const claimSidePromptOperation = mock<() => Promise<
  | { state: "claimed"; ownerToken: string }
  | { state: "running" }
  | { state: "completed"; result: Record<string, unknown> }
>>(async () => ({ state: "claimed", ownerToken: "side-owner-1" }));
const finishSidePromptOperation = mock(async (_input: unknown) => {});
const completeSidePromptOperation = mock(async (_input: unknown) => true);
const renewSidePromptOperation = mock(async () => true);
const recordOrphanedSidePromptUsage = mock(async (_input: unknown) => true);
const reserveTokenBudget = mock(async () => ({
  reserved: true,
  reservationId: "reservation-1",
  ownerToken: "reservation-owner-1",
  generation: 1,
  dailyTokens: 0,
  reservedTokens: 100,
}));
const settleTokenBudget = mock(async () => {});
const releaseTokenBudget = mock(async () => {});
const streamSimple = mock<(
  model: unknown,
  context: unknown,
  options: { signal?: AbortSignal },
) => AsyncGenerator<unknown>>(async function* (
  _model: unknown,
  _context: unknown,
  _options: { signal?: AbortSignal },
) {});

mock.module("@piclaw-cloud/store", () => ({
  getSession,
  getSessionMode,
  getSessionPlanText,
  checkQuota,
  logTokenUsage,
  claimSidePromptOperation,
  finishSidePromptOperation,
  completeSidePromptOperation,
  renewSidePromptOperation,
  recordOrphanedSidePromptUsage,
  reserveTokenBudget,
  settleTokenBudget,
  releaseTokenBudget,
}));
mock.module("./kernel/runtime.ts", () => ({
  getKernelRuntime: () => ({ model: { id: "test-model" } }),
}));
mock.module("./kernel/resolve-model.ts", () => ({
  resolveSessionKernelModel: async () => ({
    model: { id: "test-model" },
    models: { streamSimple },
  }),
  resolveModelIdForLogging: () => "piclaw-cloud/test",
}));

const {
  assertSidePromptQuota,
  createSidePromptAbortController,
  makeSidePromptResult,
  runSidePrompt,
} = await import("./side-prompt.ts");

describe("side prompt result", () => {
  beforeEach(() => {
    getSession.mockClear();
    getSessionMode.mockClear();
    getSessionPlanText.mockClear();
    checkQuota.mockClear();
    logTokenUsage.mockClear();
    claimSidePromptOperation.mockClear();
    finishSidePromptOperation.mockClear();
    completeSidePromptOperation.mockClear();
    reserveTokenBudget.mockClear();
    settleTokenBudget.mockClear();
    releaseTokenBudget.mockClear();
    streamSimple.mockClear();
    checkQuota.mockResolvedValue({ ok: true, dailyTokens: 0 });
  });

  test("returns a clear error when no assistant response arrives", () => {
    expect(makeSidePromptResult({
      text: "",
      thinking: "",
      model: "piclaw-cloud/test",
      stopReason: "stop",
    })).toEqual({
      status: "error",
      result: null,
      thinking: null,
      error: "Side prompt finished without a response.",
      model: "piclaw-cloud/test",
      stopReason: "stop",
    });
  });

  test("keeps the side reply transient and reports usage metadata", () => {
    expect(makeSidePromptResult({
      text: "A concise side answer.",
      thinking: "considering context",
      model: "piclaw-cloud/test",
      stopReason: "stop",
      usage: { inputTokens: 12, outputTokens: 8, cachedTokens: 0 },
    })).toEqual({
      status: "success",
      result: "A concise side answer.",
      thinking: "considering context",
      model: "piclaw-cloud/test",
      stopReason: "stop",
      usage: { inputTokens: 12, outputTokens: 8, cachedTokens: 0 },
    });
  });

  test("logs successful side-prompt usage under its own source", async () => {
    streamSimple.mockImplementation(async function* () {
      yield { type: "text_delta", delta: "answer" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          stopReason: "stop",
          usage: { input: 12, output: 8, cacheRead: 3, cacheWrite: 0 },
        },
      };
    });

    const result = await runSidePrompt("session-1", "Summarize this", {
      operationId: "side-op-1",
    });

    expect(result.status).toBe("success");
    expect(result.operationId).toBe("side-op-1");
    expect(completeSidePromptOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "side-op-1",
      ownerToken: "side-owner-1",
      sessionId: "session-1",
      userId: "user-1",
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 3,
      reasoningTokens: 0,
      cacheWriteTokens: 0,
      status: "success",
    }));
  });

  test("replays a completed operation without invoking the provider or duplicating usage", async () => {
    claimSidePromptOperation.mockResolvedValueOnce({
      state: "completed",
      result: {
        status: "success",
        result: "persisted answer",
        thinking: null,
        model: "piclaw-cloud/test",
        operationId: "stable-op",
      },
    });

    const result = await runSidePrompt("session-1", "Summarize this", {
      operationId: "stable-op",
    });

    expect(result).toMatchObject({
      status: "success",
      result: "persisted answer",
      operationId: "stable-op",
    });
    expect(streamSimple).not.toHaveBeenCalled();
    expect(completeSidePromptOperation).not.toHaveBeenCalled();
  });

  test("records provider usage when the side prompt ends in error", async () => {
    streamSimple.mockImplementation(async function* () {
      yield {
        type: "error",
        error: {
          role: "assistant",
          content: [],
          stopReason: "error",
          usage: { input: 9, output: 2, cacheRead: 1, cacheWrite: 0 },
        },
      };
    });

    const result = await runSidePrompt("session-1", "Fail after usage", {
      operationId: "failed-op",
    });

    expect(result.status).toBe("error");
    expect(completeSidePromptOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "failed-op",
      inputTokens: 9,
      outputTokens: 2,
      cacheReadTokens: 1,
      reasoningTokens: 0,
      cacheWriteTokens: 0,
      status: "error",
    }));
  });

  test("rejects a side prompt before opening a model stream when daily quota is exhausted", async () => {
    checkQuota.mockResolvedValue({
      ok: false,
      reason: "daily_token_limit",
      dailyTokens: 500_000,
    });

    await expect(assertSidePromptQuota("session-1")).rejects.toMatchObject({
      name: "QuotaExceededError",
      code: "daily_tokens",
      limit: 500_000,
      used: 500_000,
    });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  test("forwards request abort to the isolated model stream", async () => {
    let observedAbort = false;
    streamSimple.mockImplementation(async function* (
      _model: unknown,
      _context: unknown,
      options: { signal?: AbortSignal },
    ) {
      yield { type: "text_delta", delta: "partial" };
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
      throw new Error("request aborted");
    });
    const controller = new AbortController();

    const result = await runSidePrompt("session-1", "Summarize this", {
      signal: controller.signal,
      onTextDelta: () => setTimeout(() => controller.abort(), 0),
    });

    expect(observedAbort).toBe(true);
    expect(result).toMatchObject({
      status: "error",
      result: null,
      thinking: null,
      stopReason: "aborted",
    });
  });

  test("cancels the model signal when the SSE response is cancelled", () => {
    const abort = createSidePromptAbortController(new AbortController().signal);

    abort.cancel();

    expect(abort.signal.aborted).toBe(true);
  });
});
