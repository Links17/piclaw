import { expect, test } from 'bun:test';

import { sessionHasWorkspace, remoteAccessTabsAvailable, normalizeSandboxWorkspacePath, shouldAutoRevealWorkspaceForSandboxBinding, resolveWorkspaceAvailable, shouldAutoRevealWorkspaceOnAvailabilityChange, inferWorkspaceAvailableFromIndexStatus, createRevealWorkspacePanelAction } from '../../web/src/ui/workspace-visibility.js';

test('sessionHasWorkspace is always true outside cloud builds', () => {
  expect(sessionHasWorkspace(null, { cloudBuild: false })).toBe(true);
  expect(sessionHasWorkspace({ sandbox_id: null }, { cloudBuild: false })).toBe(true);
});

test('sessionHasWorkspace requires sandbox_id on cloud builds', () => {
  expect(sessionHasWorkspace(null, { cloudBuild: true })).toBe(false);
  expect(sessionHasWorkspace({ sandbox_id: null }, { cloudBuild: true })).toBe(false);
  expect(sessionHasWorkspace({ sandbox_id: '  ' }, { cloudBuild: true })).toBe(false);
  expect(sessionHasWorkspace({ sandbox_id: 'sbx-123' }, { cloudBuild: true })).toBe(true);
});

test('remoteAccessTabsAvailable is disabled on cloud builds', () => {
  expect(remoteAccessTabsAvailable({ cloudBuild: false })).toBe(true);
  expect(remoteAccessTabsAvailable({ cloudBuild: true })).toBe(false);
});

test('normalizeSandboxWorkspacePath strips /workspace prefix', () => {
  expect(normalizeSandboxWorkspacePath('/workspace/demo.ino')).toBe('demo.ino');
  expect(normalizeSandboxWorkspacePath('demo.ino')).toBe('demo.ino');
  expect(normalizeSandboxWorkspacePath('/etc/passwd')).toBeNull();
});

test('shouldAutoRevealWorkspaceForSandboxBinding only fires on new sandbox ids', () => {
  expect(shouldAutoRevealWorkspaceForSandboxBinding(null, null)).toBe(false);
  expect(shouldAutoRevealWorkspaceForSandboxBinding('sbx-a', 'sbx-a')).toBe(false);
  expect(shouldAutoRevealWorkspaceForSandboxBinding(null, 'sbx-a')).toBe(true);
  expect(shouldAutoRevealWorkspaceForSandboxBinding('sbx-a', 'sbx-b')).toBe(true);
});

test('resolveWorkspaceAvailable honors probe hint on cloud builds', () => {
  expect(resolveWorkspaceAvailable(null, { cloudBuild: true, probeAvailable: false })).toBe(false);
  expect(resolveWorkspaceAvailable(null, { cloudBuild: true, probeAvailable: true })).toBe(true);
  expect(resolveWorkspaceAvailable({ sandbox_id: 'sbx-1' }, { cloudBuild: true, probeAvailable: false })).toBe(true);
});

test('shouldAutoRevealWorkspaceOnAvailabilityChange only fires on false to true', () => {
  expect(shouldAutoRevealWorkspaceOnAvailabilityChange(false, false)).toBe(false);
  expect(shouldAutoRevealWorkspaceOnAvailabilityChange(true, true)).toBe(false);
  expect(shouldAutoRevealWorkspaceOnAvailabilityChange(true, false)).toBe(false);
  expect(shouldAutoRevealWorkspaceOnAvailabilityChange(false, true)).toBe(true);
});

test('inferWorkspaceAvailableFromIndexStatus requires has_sandbox', () => {
  expect(inferWorkspaceAvailableFromIndexStatus({ state: 'ready' })).toBe(false);
  expect(inferWorkspaceAvailableFromIndexStatus({ has_sandbox: true })).toBe(true);
  expect(inferWorkspaceAvailableFromIndexStatus({ has_sandbox: false })).toBe(false);
});

test('createRevealWorkspacePanelAction opens workspace and marks probe available', () => {
  let open = false;
  let probe = false;
  const reveal = createRevealWorkspacePanelAction({
    setWorkspaceOpen: (next) => { open = next; },
    setWorkspaceProbeAvailable: (next) => { probe = next; },
  });
  reveal();
  expect(open).toBe(true);
  expect(probe).toBe(true);
});
