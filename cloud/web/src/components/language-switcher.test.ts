import { expect, test } from 'bun:test';

import { buildLanguageOptions } from './language-switcher.js';
import { SUPPORTED_LOCALES } from '../utils/i18n.js';

test('buildLanguageOptions lists every supported locale once', () => {
  const options = buildLanguageOptions('en');
  expect(options.map((o) => o.value)).toEqual([...SUPPORTED_LOCALES]);
  expect(options).toHaveLength(SUPPORTED_LOCALES.length);
});

test('buildLanguageOptions marks exactly the active locale', () => {
  const options = buildLanguageOptions('ja');
  const active = options.filter((o) => o.active);
  expect(active).toHaveLength(1);
  expect(active[0].value).toBe('ja');
});

test('buildLanguageOptions exposes human-readable labels', () => {
  const labels = Object.fromEntries(buildLanguageOptions('en').map((o) => [o.value, o.label]));
  expect(labels.en).toBe('English');
  expect(labels['zh-CN']).toBe('简体中文');
  expect(labels.ja).toBe('日本語');
});
