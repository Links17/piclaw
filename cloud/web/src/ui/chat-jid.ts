declare const __PICLAW_API_BASE__: string | undefined;

export const LEGACY_DEFAULT_CHAT_JID = 'web:default';

/** Cloud web builds inject __PICLAW_API_BASE__; local runtime does not. */
export function isCloudWebBuild(): boolean {
  return typeof __PICLAW_API_BASE__ !== 'undefined';
}

/** Fallback chat jid when navigation must target a concrete session (local runtime only). */
export function legacyDefaultChatJid(): string {
  return isCloudWebBuild() ? '' : LEGACY_DEFAULT_CHAT_JID;
}

/** Normalize URL/runtime chat ids; cloud treats legacy default as no selection. */
export function normalizeActiveChatJid(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  if (isCloudWebBuild() && normalized === LEGACY_DEFAULT_CHAT_JID) return '';
  return normalized;
}

/** Compare chat ids, treating legacy default as equivalent to empty in cloud builds. */
export function chatJidsMatch(left: unknown, right: unknown): boolean {
  const a = normalizeActiveChatJid(left);
  const b = normalizeActiveChatJid(right);
  if (a && b) return a === b;
  if (!a && !b) return true;
  const legacy = LEGACY_DEFAULT_CHAT_JID;
  return (a === legacy && !b) || (b === legacy && !a);
}

/** Resolve the next session after deletion. */
export function resolveNextChatJidAfterRemoval(
  removedChatJid: string,
  sessions: Array<{ chat_jid?: string }> | null | undefined,
): string {
  const removed = normalizeActiveChatJid(removedChatJid);
  const list = Array.isArray(sessions) ? sessions : [];
  for (const row of list) {
    const jid = normalizeActiveChatJid(row?.chat_jid);
    if (!jid || jid === removed) continue;
    return jid;
  }
  return legacyDefaultChatJid();
}

/** Chat jid for building navigation URLs (may fall back locally). */
export function resolveChatNavigationJid(chatJid: unknown): string {
  const normalized = normalizeActiveChatJid(chatJid);
  return normalized || legacyDefaultChatJid();
}
