/**
 * Async session title generation — short LLM summary with deterministic fallback.
 */
import * as store from "@piclaw-cloud/store";
import { UNTITLED_SESSION_TITLE } from "@piclaw-cloud/store";
import { streamCompletionRound } from "./llm.ts";

const MAX_TITLE_LENGTH = 80;

export function sanitizeGeneratedTitle(raw: string): string {
  let title = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ");
  if (title.length > MAX_TITLE_LENGTH) {
    title = `${title.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
  }
  return title || UNTITLED_SESSION_TITLE;
}

export function fallbackTitleFromMessage(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (!cleaned) return UNTITLED_SESSION_TITLE;
  if (cleaned.length <= 60) return cleaned;
  return `${cleaned.slice(0, 57).trimEnd()}...`;
}

export async function generateSessionTitleFromMessage(message: string): Promise<string> {
  const prompt = message.trim();
  if (!prompt) return UNTITLED_SESSION_TITLE;

  try {
    const round = await streamCompletionRound(
      [
        {
          role: "system",
          content:
            "Generate a concise chat title (3-6 words). Reply with the title only. No quotes, punctuation wrappers, or explanation.",
        },
        { role: "user", content: prompt.slice(0, 2000) },
      ],
      async () => {},
      [],
    );
    const sanitized = sanitizeGeneratedTitle(round.text);
    if (sanitized && !store.isTemporarySessionTitle(sanitized)) {
      return sanitized;
    }
  } catch {
    // fall through to message-based fallback
  }

  return fallbackTitleFromMessage(prompt);
}

export function scheduleSessionTitleGeneration(
  sessionId: string,
  userId: string,
  firstMessage: string,
): void {
  void (async () => {
    const title = await generateSessionTitleFromMessage(firstMessage);
    await store.renameSessionTitleIfTemporary(sessionId, title, userId);
  })().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[session-title] failed for ${sessionId}: ${detail}`);
  });
}
