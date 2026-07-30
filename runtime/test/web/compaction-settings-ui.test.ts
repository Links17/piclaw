import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runtimeRoot = join(import.meta.dir, "../..");

function source(path: string): string {
  return readFileSync(join(runtimeRoot, path), "utf8");
}

test("classic compaction settings expose and persist both canonical processing methods", () => {
  const component = source("web/src/components/settings/compaction.ts");
  const i18n = source("web/src/utils/i18n.ts");
  const bundle = source("web/static/classic/dist/app.bundle.js");

  expect(component).toContain("smartCompactionMethod: normalizeSmartCompactionMethod(data.smartCompactionMethod)");
  expect(component).toContain("smartCompactionMethod,\n        remoteCompactionEnabled,\n        remoteCompactionTimeoutSec,\n        compactionTimeoutSec");
  expect(component).toContain("body: currentSnapshot");
  expect(component).toContain("replace(/[\\s-]+/g, '_')");
  expect(component).toContain("normalized === 'pipelined' || normalized === 'traditional_pipelined' ? 'pipelined' : 'selective'");
  expect(component).toContain('<option value="selective">');
  expect(component).toContain('<option value="pipelined">');
  expect(component).toContain("remoteCompactionEnabled: Boolean(data.remoteCompactionEnabled ?? false)");
  expect(component).toContain("remoteCompactionTimeoutSec: data.remoteCompactionTimeoutSec ?? 300");
  expect(component).toContain("t('settings.compaction.remoteNative'");
  expect(component).toContain("mergeSettingsData?.(payload.settings)");
  expect(component).toContain("applyIncoming({ ...(settingsData || {}), ...(payload.settings || {}) })");
  expect(i18n).toContain("'settings.compaction.methodSelective': 'Selective'");
  expect(i18n).toContain("'settings.compaction.methodPipelined': 'Pipelined'");
  expect(i18n).toContain("'settings.compaction.remoteNative': 'Provider-native compaction'");
  expect(bundle).toContain('value="pipelined"');
  expect(bundle).toContain('remoteCompactionEnabled');
});
