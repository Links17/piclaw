import { html, useState } from '../vendor/preact-htm.js';
import { answerAgentQuestion } from '../api.js';

const QUESTION_ANSWER_TIMEOUT_MS = 30_000;

async function answerAgentQuestionWithTimeout(
  chatJid: string,
  questionId: string,
  answer: string,
): Promise<Awaited<ReturnType<typeof answerAgentQuestion>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Submit timed out — please try again or reply in the chat input.')),
      QUESTION_ANSWER_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      answerAgentQuestion(chatJid, questionId, answer),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export interface AgentQuestionState {
  questionId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}

function normalizeOptions(
  options: Array<{ label: string; description?: string }> | undefined,
): Array<{ label: string; description?: string }> {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => {
      if (typeof option === 'string') {
        return { label: option.trim() };
      }
      return {
        label: String(option?.label ?? '').trim(),
        description: option?.description ? String(option.description) : undefined,
      };
    })
    .filter((option) => option.label.length > 0);
}

export function AgentQuestionPanel({
  question,
  chatJid,
  onAnswered,
}: {
  question: AgentQuestionState | null;
  chatJid: string;
  onAnswered?: () => void;
}) {
  const [customAnswer, setCustomAnswer] = useState('');
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!question) return null;

  const options = normalizeOptions(question.options);

  async function submitAnswer(answer: string) {
    const trimmed = answer.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await answerAgentQuestionWithTimeout(chatJid, question.questionId, trimmed);
      if (result?.ok === false) {
        throw new Error(String(result?.error || 'Failed to submit answer'));
      }
      setSelectedOption(null);
      setCustomAnswer('');
      onAnswered?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit answer';
      setSubmitError(message);
      console.error('[agent-question] submit failed:', error);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmitSelected = Boolean(selectedOption?.trim()) && !submitting;
  const canSubmitCustom = Boolean(customAnswer.trim()) && !submitting;

  return html`
    <div
      class="agent-thinking agent-thinking-question"
      data-testid="agent-question-panel"
      data-no-chat-swipe="true"
      aria-live="polite"
    >
      <div class="agent-thinking-title thought">
        <span class="turn-dot" aria-hidden="true"></span>
        Question
      </div>
      <div class="agent-thinking-body agent-question-body">
        <p class="agent-question-prompt">${question.question}</p>
        ${options.length > 0 && html`
          <div class="agent-question-options" role="listbox" aria-label="Answer options">
            ${options.map(
              (option) => html`
                <button
                  type="button"
                  key=${option.label}
                  role="option"
                  aria-selected=${selectedOption === option.label}
                  class=${`agent-question-option${selectedOption === option.label ? ' is-selected' : ''}`}
                  data-no-chat-swipe="true"
                  disabled=${submitting}
                  onClick=${(event: Event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSelectedOption(option.label);
                    setSubmitError(null);
                  }}
                >
                  <span class="agent-question-option-label">${option.label}</span>
                  ${option.description
                    ? html`<span class="agent-question-option-desc">${option.description}</span>`
                    : null}
                </button>
              `,
            )}
          </div>
        `}
        ${selectedOption && html`
          <div class="agent-question-selected-row">
            <button
              type="button"
              class="agent-question-submit agent-question-submit-selected"
              data-no-chat-swipe="true"
              disabled=${!canSubmitSelected || submitting}
              onClick=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                if (selectedOption) void submitAnswer(selectedOption);
              }}
            >
              ${submitting ? 'Submitting…' : `Submit: ${selectedOption}`}
            </button>
          </div>
        `}
        <div class="agent-question-custom">
          <input
            type="text"
            class="agent-question-custom-input"
            data-no-chat-swipe="true"
            placeholder="Or type a custom answer..."
            value=${customAnswer}
            disabled=${submitting}
            onInput=${(event: Event) => {
              setCustomAnswer((event.target as HTMLInputElement).value);
              setSelectedOption(null);
              setSubmitError(null);
            }}
            onKeyDown=${(event: KeyboardEvent) => {
              if (event.key === 'Enter') void submitAnswer(customAnswer);
            }}
          />
          <button
            type="button"
            class="agent-question-submit"
            data-no-chat-swipe="true"
            disabled=${!canSubmitCustom || submitting}
            onClick=${(event: Event) => {
              event.preventDefault();
              event.stopPropagation();
              void submitAnswer(customAnswer);
            }}
          >
            ${submitting ? '…' : 'Submit'}
          </button>
        </div>
        ${submitError && html`<p class="agent-question-error" role="alert">${submitError}</p>`}
        <p class="agent-question-compose-hint">You can also reply directly in the chat input.</p>
      </div>
    </div>
  `;
}
