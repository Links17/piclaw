import { expect, test } from 'bun:test';

import {
  LEGACY_DEFAULT_CHAT_JID,
  legacyDefaultChatJid,
  normalizeActiveChatJid,
  resolveNextChatJidAfterRemoval,
} from '../../web/src/ui/chat-jid.js';

test('normalizeActiveChatJid trims and preserves non-default ids', () => {
  expect(normalizeActiveChatJid('')).toBe('');
  expect(normalizeActiveChatJid('  web:abc  ')).toBe('web:abc');
});

test('legacyDefaultChatJid falls back locally when cloud define is absent', () => {
  expect(legacyDefaultChatJid()).toBe(LEGACY_DEFAULT_CHAT_JID);
});

test('resolveNextChatJidAfterRemoval skips archived and removed sessions', () => {
  const sessions = [
    { chat_jid: 'web:removed', archived_at: null },
    { chat_jid: 'web:kept', archived_at: null },
    { chat_jid: 'web:archived', archived_at: '2026-01-01T00:00:00.000Z' },
  ];
  expect(resolveNextChatJidAfterRemoval('web:removed', sessions)).toBe('web:kept');
  expect(resolveNextChatJidAfterRemoval('web:kept', sessions)).toBe('web:removed');
});
