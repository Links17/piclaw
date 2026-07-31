import { describe, expect, test } from 'bun:test';
import {
  appendSubagentDelta,
  getCloudFleetRuns,
  upsertCloudFleetRun,
  clearCloudAgentExtensions,
} from './app-cloud-agent-extensions.ts';

describe('cloud fleet run state', () => {
  test('upsert and append delta', () => {
    clearCloudAgentExtensions();
    upsertCloudFleetRun({
      runId: 'run-test',
      agentType: 'general-purpose',
      description: 'demo task',
      status: 'running',
    });
    appendSubagentDelta('run-test', 'hello');
    const run = getCloudFleetRuns().find((entry) => entry.runId === 'run-test');
    expect(run?.deltaPreview).toBe('hello');
    clearCloudAgentExtensions();
  });
});
