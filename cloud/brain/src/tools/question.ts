import { config } from "../config.ts";
import { publish } from "../events.ts";
import {
  clearPendingQuestionState,
  getPendingQuestionState,
  setPendingQuestionState,
} from "../agent-run-state.ts";
import {
  abortQuestionWait,
  clearQuestionWait,
  createQuestionId,
  QUESTION_ABORT_SENTINEL,
  submitQuestionAnswer,
  waitForQuestionAnswer,
} from "../question/channel.ts";
import { clearPendingQuestion, getPendingQuestion, setPendingQuestion } from "../question/state.ts";
import { TurnAbortedError, isTurnAborted } from "../turn-abort.ts";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionToolArgs {
  question: string;
  options: QuestionOption[];
}

function trackPending(
  sessionId: string,
  pending: { questionId: string; question: string; options: QuestionOption[]; createdAt: number },
): void {
  setPendingQuestion(sessionId, pending);
  setPendingQuestionState(sessionId, pending);
}

async function clearPending(sessionId: string): Promise<void> {
  clearPendingQuestion(sessionId);
  clearPendingQuestionState(sessionId);
  await publish(sessionId, {
    type: "question_cleared",
    replica: config.replicaId,
  });
}

export async function publishQuestionCleared(sessionId: string): Promise<void> {
  await publish(sessionId, {
    type: "question_cleared",
    replica: config.replicaId,
  });
}

export async function runQuestionTool(
  sessionId: string,
  args: QuestionToolArgs,
): Promise<{ output: string; isError: boolean }> {
  const question = String(args.question ?? "").trim();
  const options = Array.isArray(args.options)
    ? args.options
        .map((option) => ({
          label: String(option?.label ?? "").trim(),
          description: option?.description ? String(option.description) : undefined,
        }))
        .filter((option) => option.label.length > 0)
    : [];

  if (!question) return { output: "question is required", isError: true };
  if (options.length === 0) return { output: "at least one option is required", isError: true };

  const questionId = createQuestionId();
  trackPending(sessionId, { questionId, question, options, createdAt: Date.now() });

  await publish(sessionId, {
    type: "question_asked",
    questionId,
    question,
    options,
    replica: config.replicaId,
  });

  try {
    const answer = await waitForQuestionAnswer(sessionId, questionId, config.questionTimeoutMs);

    if (answer === QUESTION_ABORT_SENTINEL || isTurnAborted(sessionId)) {
      throw new TurnAbortedError();
    }

    if (!answer) {
      return {
        output:
          "User did not answer (timeout). Proceed with reasonable defaults; do not call the question tool again for this ambiguity.",
        isError: true,
      };
    }

    const matchedIndex = options.findIndex((option) => option.label === answer);
    if (matchedIndex >= 0) {
      return {
        output: `User selected: ${matchedIndex + 1}. ${answer}`,
        isError: false,
      };
    }

    return {
      output: `User wrote: ${answer}`,
      isError: false,
    };
  } finally {
    await clearPending(sessionId);
    await clearQuestionWait(sessionId, questionId);
  }
}

export async function answerPendingQuestion(
  sessionId: string,
  questionId: string,
  answer: string,
): Promise<{ ok: boolean; error?: string }> {
  const pending = getPendingQuestion(sessionId) ?? getPendingQuestionState(sessionId);
  if (!pending) return { ok: false, error: "no pending question" };
  if (pending.questionId !== questionId) {
    return { ok: false, error: "question id mismatch" };
  }
  const trimmed = answer.trim();
  if (!trimmed) return { ok: false, error: "answer required" };
  await submitQuestionAnswer(sessionId, questionId, trimmed);
  await clearPending(sessionId);
  return { ok: true };
}

export async function answerPendingQuestionForSession(
  sessionId: string,
  answer: string,
): Promise<{ ok: boolean; error?: string; questionId?: string }> {
  const pending = getPendingQuestion(sessionId) ?? getPendingQuestionState(sessionId);
  if (!pending) return { ok: false, error: "no pending question" };
  const result = await answerPendingQuestion(sessionId, pending.questionId, answer);
  return { ...result, questionId: pending.questionId };
}

export async function interruptPendingQuestion(sessionId: string): Promise<boolean> {
  const pending = getPendingQuestion(sessionId) ?? getPendingQuestionState(sessionId);
  if (!pending) return false;
  await abortQuestionWait(sessionId, pending.questionId);
  return true;
}
