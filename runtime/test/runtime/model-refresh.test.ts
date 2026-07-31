import { expect, test } from "bun:test";
import type { ModelsRefreshResult } from "@piclaw/agent-kernel";

import { ModelRefreshCoordinator } from "../../src/runtime/model-refresh.js";

test("model refresh coordinator coalesces concurrent refreshes", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new ModelRefreshCoordinator({
    modelRuntime: {
      refresh: async () => {
        calls += 1;
        await blocker;
        return { aborted: false, errors: new Map() };
      },
    },
  });

  const first = coordinator.queue();
  const second = coordinator.queue();
  expect(first).toBe(second);
  expect(calls).toBe(1);
  release?.();
  expect(await first).toMatchObject({ status: "completed" });
  await coordinator.queue();
  expect(calls).toBe(2);
});

test("model refresh coordinator aborts a bounded refresh without rejecting", async () => {
  let sawAbort = false;
  const coordinator = new ModelRefreshCoordinator({
    timeoutMs: 10,
    modelRuntime: {
      refresh: ({ signal } = {}) => new Promise<ModelsRefreshResult>((resolve) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          resolve({ aborted: true, errors: new Map() });
        }, { once: true });
      }),
    },
  });

  expect(await coordinator.queue()).toMatchObject({ status: "timed_out" });
  expect(sawAbort).toBe(true);
});

test("model refresh coordinator returns on timeout when provider ignores abort and does not duplicate it", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new ModelRefreshCoordinator({
    timeoutMs: 10,
    modelRuntime: {
      refresh: async () => {
        calls += 1;
        await blocker;
        return { aborted: false, errors: new Map() };
      },
    },
  });

  const startedAt = Date.now();
  expect(await coordinator.queue()).toMatchObject({ status: "timed_out" });
  expect(Date.now() - startedAt).toBeLessThan(200);
  expect(await coordinator.queue()).toMatchObject({ status: "timed_out" });
  expect(calls).toBe(1);
  release?.();
  await Bun.sleep(1);
  expect(await coordinator.queue()).toMatchObject({ status: "completed" });
  expect(calls).toBe(2);
});

test("model refresh coordinator reports provider errors without throwing", async () => {
  const errors = new Map([["provider", new Error("catalog unavailable")]]);
  const coordinator = new ModelRefreshCoordinator({
    modelRuntime: {
      refresh: async () => ({ aborted: false, errors }),
    },
  });
  const result = await coordinator.queue();
  expect(result.status).toBe("completed");
  expect(result.errors.get("provider")?.message).toBe("catalog unavailable");
});
