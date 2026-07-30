import { describe, expect, test } from "bun:test";
import {
  clearQuestionWait,
  createQuestionId,
  submitQuestionAnswer,
  waitForQuestionAnswer,
} from "./channel.ts";

describe("question channel", () => {
  test("lpush unblocks concurrent brpop within 500ms", async () => {
    const sessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const questionId = createQuestionId();
    const answer = "option-a";

    const waitPromise = waitForQuestionAnswer(sessionId, questionId, 5000);
    await Bun.sleep(50);

    const startedAt = Date.now();
    await submitQuestionAnswer(sessionId, questionId, answer);
    const result = await waitPromise;

    expect(result).toBe(answer);
    expect(Date.now() - startedAt).toBeLessThan(500);

    await clearQuestionWait(sessionId, questionId);
  });
});
