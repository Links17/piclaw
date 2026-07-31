/** Brain request authentication — API key bearer or dev fallback. */
import * as store from "@piclaw-cloud/store";
import { DEFAULT_USER_ID } from "@piclaw-cloud/shared/sse-events";
import { config } from "./config.ts";
import { chatJidToSessionId } from "./web-adapter.ts";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export async function resolveRequestUser(req: Request): Promise<string> {
  const header =
    req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    req.headers.get("X-Api-Key")?.trim() ||
    "";

  if (header) {
    if (config.devApiKey && header === config.devApiKey) {
      return DEFAULT_USER_ID;
    }
    const userId = await store.verifyApiKey(header);
    if (userId) return userId;
    throw new AuthError("invalid api key");
  }

  if (config.authRequired) {
    throw new AuthError("authentication required");
  }
  return DEFAULT_USER_ID;
}

export async function requireSessionAccess(sessionId: string, userId: string): Promise<void> {
  const session = await store.getSessionForUser(sessionId, userId);
  if (!session) {
    const exists = await store.getSession(sessionId);
    if (exists && config.authRequired) {
      throw new AuthError("session access denied");
    }
    if (!exists) {
      throw new Error("unknown session");
    }
  }
}

/** Resolve user, set RLS context, and verify session access for a web chat_jid. */
export async function authorizeChatAccess(req: Request, chatJid: string): Promise<string> {
  const userId = await resolveRequestUser(req);
  await store.setUserContext(userId);
  const sessionId = chatJidToSessionId(chatJid);
  if (!sessionId) {
    throw new AuthError("chat_jid required");
  }
  await requireSessionAccess(sessionId, userId);
  return userId;
}
