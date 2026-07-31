import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getSessionRowCapabilities, resolveBranchRecordByChatJid } from '../../web/src/ui/session-row-capabilities.js';

describe('session row capabilities', () => {
  test('allows edit on active non-archived sessions', () => {
    const caps = getSessionRowCapabilities({
      chat_jid: 'web:child',
      root_chat_jid: 'web:root',
      is_active: false,
    }, { canDelete: true, canPurgeArchived: true });
    expect(caps.canEdit).toBe(true);
    expect(caps.canPrune).toBe(true);
    expect(caps.canDelete).toBe(true);
    expect(caps.showMenu).toBe(true);
  });

  test('allows delete on the current non-default session even when active', () => {
    const caps = getSessionRowCapabilities({
      chat_jid: 'web:my-session',
      root_chat_jid: 'web:my-session',
      is_active: true,
    }, { currentChatJid: 'web:my-session', canDelete: true, canPurgeArchived: true });
    expect(caps.canDelete).toBe(true);
    expect(caps.canPrune).toBe(true);
  });

  test('allows delete on non-current root sessions such as legacy default', () => {
    const caps = getSessionRowCapabilities({
      chat_jid: 'web:default',
      root_chat_jid: 'web:default',
      is_active: true,
    }, { currentChatJid: 'web:other', canDelete: true, canPurgeArchived: true, allowRootDelete: true });
    expect(caps.canDelete).toBe(true);
    expect(caps.canPrune).toBe(true);
  });

  test('allows delete on any current root session including legacy default id', () => {
    const caps = getSessionRowCapabilities({
      chat_jid: 'web:default',
      root_chat_jid: 'web:default',
      is_active: true,
    }, { currentChatJid: 'web:default', canDelete: true, canPurgeArchived: true });
    expect(caps.canDelete).toBe(true);
    expect(caps.canEdit).toBe(true);
  });

  test('blocks edit and prune on archived sessions but allows purge', () => {
    const caps = getSessionRowCapabilities({
      chat_jid: 'web:archived',
      root_chat_jid: 'web:root',
      archived_at: '2026-01-01T00:00:00.000Z',
    }, { canDelete: true, canPurgeArchived: true });
    expect(caps.canEdit).toBe(false);
    expect(caps.canPrune).toBe(false);
    expect(caps.canPurgeArchived).toBe(true);
    expect(caps.canDelete).toBe(true);
  });

  test('resolveBranchRecordByChatJid searches provided lists in order', () => {
    const found = resolveBranchRecordByChatJid('web:b', [{ chat_jid: 'web:a' }], [{ chat_jid: 'web:b', agent_name: 'beta' }]);
    expect(found?.agent_name).toBe('beta');
  });
});

describe('session sidebar css', () => {
  const css = readFileSync(
    path.join(import.meta.dir, '../../web/static/classic/css/session-sidebar.css'),
    'utf8',
  );
  const editorCss = readFileSync(
    path.join(import.meta.dir, '../../web/static/classic/css/editor.css'),
    'utf8',
  );

  test('uses row layout with trailing menu button', () => {
    expect(css).toContain('.session-sidebar-item-row');
    expect(css).toContain('.session-sidebar-item-menu');
    expect(css).not.toContain('.session-sidebar-footer');
  });

  test('workspace collapsed keeps session rail left-aligned', () => {
    expect(editorCss).toContain(
      '.app-shell.workspace-collapsed:has(.session-sidebar, .session-sidebar-collapsed) .container',
    );
    expect(editorCss).not.toMatch(
      /\.app-shell\.workspace-collapsed:not\([^)]+\)\s*\{\s*justify-content:\s*center;/,
    );
  });
});

describe('post chat alignment css', () => {
  const css = readFileSync(
    path.join(import.meta.dir, '../../web/static/classic/css/content.css'),
    'utf8',
  );

  test('aligns agent posts left and user posts right', () => {
    expect(css).toContain('.post.agent-post');
    expect(css).toContain('align-self: flex-start');
    expect(css).toContain('.post.user-post');
    expect(css).toContain('align-self: flex-end');
    expect(css).toContain('flex-direction: row-reverse');
  });
});
