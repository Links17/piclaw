import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('workspace menu portal css', () => {
  const workspaceCss = readFileSync(
    path.join(import.meta.dir, '../../web/static/classic/css/workspace.css'),
    'utf8',
  );
  const settingsCss = readFileSync(
    path.join(import.meta.dir, '../../web/static/classic/css/settings.css'),
    'utf8',
  );

  test('defines fixed portal host above timeline menu layer', () => {
    expect(workspaceCss).toContain('.workspace-menu-portal-host');
    expect(workspaceCss).toContain('z-index: 2100');
    expect(workspaceCss).toContain('pointer-events: none');
    expect(workspaceCss).toContain('.workspace-menu-dropdown-portal');
  });

  test('keeps workspace header menu visible', () => {
    const ruleMatch = settingsCss.match(/\.workspace-header-left > \.workspace-menu-wrap\s*\{[^}]+\}/);
    expect(ruleMatch?.[0]).toContain('.workspace-header-left > .workspace-menu-wrap');
    expect(ruleMatch?.[0]).toContain('display: inline-flex');
    expect(ruleMatch?.[0]).not.toContain('display: none');
  });
});

describe('workspace explorer portal wiring', () => {
  const source = readFileSync(
    path.join(import.meta.dir, '../../web/src/components/workspace-explorer.ts'),
    'utf8',
  );

  test('renders dropdown through BodyPortal with fixed coordinates', () => {
    expect(source).toContain("import { BodyPortal } from './body-portal.js'");
    expect(source).toContain('workspace-menu-portal-host');
    expect(source).toContain('workspace-menu-dropdown-portal');
    expect(source).toContain('updateHeaderMenuPosition');
  });
});
