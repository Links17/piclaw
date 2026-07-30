import { expect, test } from 'bun:test';

import {
  formatNotificationTitle,
  shouldShowNotificationSourceLabels,
  WEB_PUSH_NOTIFICATION_SOURCE_LABEL,
} from '../../web/src/ui/use-notifications.js';

test('formatNotificationTitle hides the source marker by default', () => {
  expect(formatNotificationTitle('PiClaw', WEB_PUSH_NOTIFICATION_SOURCE_LABEL)).toBe('PiClaw');
});

test('formatNotificationTitle appends the source marker when debug labels are enabled', () => {
  expect(formatNotificationTitle('PiClaw', WEB_PUSH_NOTIFICATION_SOURCE_LABEL, {
    __PICLAW_NOTIFICATION_SOURCE_LABELS_ENABLED__: true,
  })).toBe('PiClaw [Web Push]');
});

test('shouldShowNotificationSourceLabels reads the boot flag from the runtime window', () => {
  expect(shouldShowNotificationSourceLabels({ __PICLAW_NOTIFICATION_SOURCE_LABELS_ENABLED__: true })).toBe(true);
  expect(shouldShowNotificationSourceLabels({ __PICLAW_NOTIFICATION_SOURCE_LABELS_ENABLED__: false })).toBe(false);
});

test('formatNotificationTitle falls back cleanly when no source marker is provided', () => {
  expect(formatNotificationTitle('Pi', '')).toBe('Pi');
  expect(formatNotificationTitle('', '')).toBe('Seeed');
});
