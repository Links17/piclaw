import { expect, test } from 'bun:test';

import { countAvailableModels, resolveOobePanelState } from './oobe-state.js';

test('countAvailableModels counts model_options first and falls back to models', () => {
  expect(countAvailableModels({ model_options: [{ label: 'a' }, { label: 'b' }], models: ['x'] })).toBe(2);
  expect(countAvailableModels({ models: ['a', '', 'b', null] })).toBe(2);
  expect(countAvailableModels(null)).toBe(0);
});

test('configured-model hints suppress the panel when the current model exists', () => {
  expect(resolveOobePanelState({
    modelsLoaded: true,
    modelPayload: { current: 'openai/gpt-5' },
    providerMissingDismissed: false,
  })).toEqual({
    kind: 'hidden',
    hasAvailableModels: false,
    availableModelCount: 0,
    hasConfiguredModelHint: true,
  });
});

test('configured instances with available providers stay hidden', () => {
  expect(resolveOobePanelState({
    modelsLoaded: true,
    modelPayload: {
      current: 'openai/gpt-5',
      model_options: [{ label: 'openai/gpt-5', provider: 'openai', id: 'gpt-5' }],
    },
    providerMissingDismissed: false,
  })).toEqual({
    kind: 'hidden',
    hasAvailableModels: true,
    availableModelCount: 1,
    hasConfiguredModelHint: true,
  });
});
