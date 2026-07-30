import { expect, test } from 'bun:test';

import {
  describeBranchRestoreResult,
  formatBranchPickerBaseLabel,
  formatBranchPickerLabel,
  formatCurrentBranchLabel,
  formatSessionDisplayTitle,
  getBranchHandleDraftState,
  getBranchLifecycleBadges,
} from '../../web/src/ui/branch-lifecycle.js';

test('formats the current branch label as the session title only', () => {
  expect(formatCurrentBranchLabel({ agent_name: 'research', chat_jid: 'web:default:branch:1' }, 'web:default'))
    .toBe('research');
});

test('formatSessionDisplayTitle prefers agent_name and falls back to title', () => {
  expect(formatSessionDisplayTitle({ agent_name: 'friendly-greeting', chat_jid: 'web:abc' }))
    .toBe('friendly-greeting');
  expect(formatSessionDisplayTitle({ title: 'Draft notes', chat_jid: 'web:abc' }))
    .toBe('Draft notes');
  expect(formatSessionDisplayTitle({ chat_jid: 'web:abc' }))
    .toBe('New chat');
});

test('formats branch picker labels as title-only display text', () => {
  expect(formatBranchPickerBaseLabel({
    agent_name: 'builder',
    chat_jid: 'web:default:branch:2',
    is_active: true,
    archived_at: null,
  })).toBe('builder');

  expect(formatBranchPickerLabel({
    agent_name: 'builder',
    chat_jid: 'web:default:branch:2',
    is_active: true,
    archived_at: null,
  })).toBe('builder');

  expect(formatBranchPickerLabel({
    agent_name: 'builder',
    chat_jid: 'web:default:branch:2',
    is_active: true,
    is_compacting: true,
    activity_status: 'compacting',
    archived_at: null,
  }, { currentChatJid: 'web:default:branch:2' })).toBe('builder');

  expect(formatBranchPickerLabel({
    agent_name: 'release',
    chat_jid: 'web:default:branch:3',
    is_active: false,
    archived_at: '2026-03-24T00:00:00.000Z',
  })).toBe('release');
});

test('current badge stays explicit while compacting and active remain visible', () => {
  expect(getBranchLifecycleBadges({
    chat_jid: 'web:default',
    is_active: true,
    is_compacting: true,
    archived_at: null,
  }, { currentChatJid: 'web:default' })).toEqual(['current', 'compacting', 'active']);
});

test('restore result explains handle suffixing when a collision changes the final handle', () => {
  expect(describeBranchRestoreResult('release', 'release-2', 'web:default:branch:3'))
    .toBe('Restored archived @release as @release-2 because @release is already in use.');

  expect(describeBranchRestoreResult('release', 'release', 'web:default:branch:3'))
    .toBe('Restored @release.');
});

test('branch rename draft state validates empty, unchanged, and normalized handles', () => {
  expect(getBranchHandleDraftState('', 'research')).toEqual({
    normalized: '',
    handle: '',
    canSubmit: false,
    kind: 'error',
    message: 'Enter a branch handle.',
  });

  expect(getBranchHandleDraftState('research', 'research')).toEqual({
    normalized: 'research',
    handle: '@research',
    canSubmit: false,
    kind: 'info',
    message: 'Already using @research.',
  });

  expect(getBranchHandleDraftState('@Release Notes!', 'research')).toEqual({
    normalized: 'release-notes',
    handle: '@release-notes',
    canSubmit: true,
    kind: 'info',
    message: 'Will save as @release-notes. Letters, numbers, - and _ are allowed; leading @ is optional.',
  });
});
