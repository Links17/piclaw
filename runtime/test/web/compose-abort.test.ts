import { describe, expect, test } from 'bun:test';

import {
  isAbortSteerContent,
  shouldRouteComposeToQuestionAnswer,
} from '../../web/src/components/compose-box.js';
import {
  applyOptimisticAgentAbort,
  isAgentAbortResponse,
  isAbortSteerSubmit,
  shouldRouteToQuestionAnswer,
} from '../../web/src/ui/app-agent-abort.js';

describe('compose abort routing', () => {
  test('steer /abort bypasses pending question answer path', () => {
    expect(shouldRouteComposeToQuestionAnswer({
      baseContent: '/abort',
      submitMode: 'steer',
      pendingQuestion: { questionId: 'q-1' },
      mediaIds: [],
    })).toBe(false);
    expect(shouldRouteToQuestionAnswer({
      baseContent: '/abort',
      submitMode: 'steer',
      pendingQuestion: { questionId: 'q-1' },
      mediaIds: [],
    })).toBe(false);
  });

  test('normal answer still routes to question API', () => {
    expect(shouldRouteComposeToQuestionAnswer({
      baseContent: 'Wio Terminal',
      submitMode: null,
      pendingQuestion: { questionId: 'q-1' },
      mediaIds: [],
    })).toBe(true);
  });

  test('detects abort steer content', () => {
    expect(isAbortSteerContent('/abort', 'steer')).toBe(true);
    expect(isAbortSteerSubmit('/abort', 'steer')).toBe(true);
    expect(isAbortSteerContent('hello', 'steer')).toBe(false);
  });
});

describe('agent abort response handling', () => {
  test('recognizes aborted ui_only responses', () => {
    expect(isAgentAbortResponse({ outcome: 'aborted' })).toBe(true);
    expect(isAgentAbortResponse({
      ui_only: true,
      command: { status: 'success', message: 'Turn aborted' },
    })).toBe(false);
    expect(isAgentAbortResponse({ ok: true })).toBe(false);
  });

  test('applyOptimisticAgentAbort clears run state immediately', () => {
    let cleared = false;
    const wasAgentActiveRef = { current: true };
    applyOptimisticAgentAbort({
      clearAgentRunState: () => { cleared = true; },
      setAgentDraft: () => {},
      setAgentStatus: () => {},
      wasAgentActiveRef,
    });
    expect(cleared).toBe(true);
    expect(wasAgentActiveRef.current).toBe(false);
  });
});
