import { afterEach, describe, expect, test } from "bun:test";
import type {
  AutoresearchRunRow,
  AutoresearchStatus,
} from "@piclaw-cloud/store";
import {
  type AutoresearchStore,
  dismissAutoresearch,
  getAutoresearchStatus,
  resetAutoresearchForTests,
  startAutoresearch,
  stopAutoresearch,
} from "./service.ts";

const sessionId = "session-autoresearch-test";

function createRun(overrides: Partial<AutoresearchRunRow> = {}): AutoresearchRunRow {
  return {
    id: "run-1",
    session_id: sessionId,
    execution_session_id: "autoresearch:run-1",
    prompt: "Improve the benchmark.",
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: null,
    dismissed_at: null,
    stop_requested_at: null,
    summary: null,
    error: null,
    ...overrides,
  };
}

function createStore(overrides: Partial<AutoresearchStore> = {}): AutoresearchStore {
  return {
    createSession: async () => {},
    getAutoresearchRunForSession: async () => null,
    createAutoresearchRun: async () => {},
    updateAutoresearchRun: async () => {},
    ...overrides,
  };
}

afterEach(() => resetAutoresearchForTests());

describe("cloud autoresearch service", () => {
  test("starts a persistent run and launches its background turn", async () => {
    const created: Array<Record<string, unknown>> = [];
    const launched: string[] = [];
    const store = createStore({
      createAutoresearchRun: async (run) => {
        created.push(run as Record<string, unknown>);
      },
    });

    const started = await startAutoresearch({
      sessionId,
      userId: "user-1",
      prompt: "Improve the benchmark.",
      store,
      submit: async (executionSessionId, prompt) => {
        launched.push(`${executionSessionId}:${prompt}`);
        return { outcome: "ran", userMessageId: 1 };
      },
    });

    expect(started.status).toBe("running");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      sessionId,
      status: "running",
      prompt: "Improve the benchmark.",
    });
    expect(launched).toEqual([
      `${started.execution_session_id}:You are running an autoresearch experiment for the user.
Work autonomously on the requested experiment. Make real progress, report evidence, and state any blockers honestly.

Experiment request:
Improve the benchmark.`,
    ]);
  });

  test("returns a running status-panel payload from persisted state", async () => {
    const payload = await getAutoresearchStatus(sessionId, createStore({
      getAutoresearchRunForSession: async () => ({
        ...createRun(),
      }),
    }));

    expect(payload).toMatchObject({
      key: "autoresearch",
      content: [{
        type: "status_panel",
        panel: {
          key: "autoresearch",
          state: "running",
          title: "Autoresearch",
          actions: [{ key: "stop", action_type: "autoresearch.stop" }],
        },
      }],
    });
  });

  test("stops a live execution turn and persists a stopped outcome", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const aborted: string[] = [];
    const store = createStore({
      getAutoresearchRunForSession: async () => ({
        ...createRun(),
      }),
      updateAutoresearchRun: async (_id, update) => {
        updates.push(update);
      },
    });

    const stopped = await stopAutoresearch(sessionId, store, async (id) => {
      aborted.push(id);
      return { ok: true, aborted: true };
    });

    expect(stopped).toMatchObject({ ok: true, status: "stopped" });
    expect(aborted).toEqual(["autoresearch:run-1"]);
    expect(updates).toEqual([{
      status: "stopped",
      stopRequestedAt: expect.any(String),
      finishedAt: expect.any(String),
      summary: "Stopped by user.",
    }]);
  });

  test("dismisses a completed panel without deleting its run", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const result = await dismissAutoresearch(sessionId, createStore({
      getAutoresearchRunForSession: async () => ({
        ...createRun({
          status: "completed" as AutoresearchStatus,
          finished_at: "2026-01-01T00:02:00.000Z",
          summary: "Finished.",
        }),
      }),
      updateAutoresearchRun: async (_id, update) => {
        updates.push(update);
      },
    }));

    expect(result).toEqual({ ok: true, dismissed: true });
    expect(updates).toEqual([{ dismissedAt: expect.any(String) }]);
  });
});
