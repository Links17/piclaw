import { describe, expect, test } from "bun:test";
import {
  haveSameContextUsage,
  mergeContextUsage,
  normalizeContextUsage,
  persistContextUsage,
  restoreContextUsage,
  setContextUserScope,
} from "./app-status-refresh-orchestration.ts";

describe("context usage normalization", () => {
  test("normalizes snake/camel nested occupancy and billed usage sections", () => {
    const normalized = normalizeContextUsage({
      tokens: 12_000,
      context_window: 64_000,
      context: {
        used: 12_000,
        total: 64_000,
        through_message_id: 20,
        latest_message_id: 22,
        updated_at: "2026-08-01T12:00:00.000Z",
      },
      daily_quota: {
        used: 100,
        total: 1_000,
        input_tokens: 80,
        output_tokens: 20,
      },
      session_usage: {
        totals: {
          input_tokens: 70,
          output_tokens: 10,
          cache_read_tokens: 40,
        },
        latest: { input_tokens: 7, output_tokens: 1 },
        by_source: {
          assistant: { total_tokens: 80 },
        },
      },
      cache_usage: {
        totals: { cache_read_tokens: 40 },
      },
    });

    expect(normalized).toMatchObject({
      tokens: 12_000,
      contextWindow: 64_000,
      context: {
        used: 12_000,
        total: 64_000,
        throughMessageId: 20,
        latestMessageId: 22,
      },
      dailyQuota: {
        used: 100,
        inputTokens: 80,
        outputTokens: 20,
      },
      sessionUsage: {
        totals: { inputTokens: 70, cacheReadTokens: 40 },
        latest: { inputTokens: 7 },
        bySource: { assistant: { totalTokens: 80 } },
      },
      cacheUsage: {
        totals: { cacheReadTokens: 40 },
      },
    });
  });

  test("partial occupancy refresh preserves daily, session, cache, and source totals", () => {
    const previous = normalizeContextUsage({
      tokens: 10,
      contextWindow: 100,
      dailyQuota: { used: 50, total: 500 },
      sessionUsage: {
        totals: { inputTokens: 40, outputTokens: 10 },
        latest: { inputTokens: 4, outputTokens: 1 },
        bySource: { assistant: { totalTokens: 50 } },
      },
      cacheUsage: { totals: { cacheReadTokens: 20 } },
    });
    const merged = mergeContextUsage(previous, {
      context: {
        used: 20,
        percent: 20,
        model: "provider/model-a",
        updated_at: "new",
      },
      daily_quota: { used: 60 },
      sessionUsage: {
        totals: { outputTokens: 15 },
        by_source: { compaction: { total_tokens: 5 } },
      },
    });

    expect(merged).toMatchObject({
      tokens: 20,
      contextWindow: 100,
      percent: 20,
      context: {
        used: 20,
        total: 100,
        percent: 20,
        model: "provider/model-a",
        updatedAt: "new",
      },
      dailyQuota: { used: 60, total: 500 },
      sessionUsage: {
        totals: { inputTokens: 40, outputTokens: 15 },
        latest: { inputTokens: 4, outputTokens: 1 },
        bySource: {
          assistant: { totalTokens: 50 },
          compaction: { totalTokens: 5 },
        },
      },
      cacheUsage: { totals: { cacheReadTokens: 20 } },
    });
    expect(haveSameContextUsage(previous, merged)).toBe(false);
  });

  test("isolates local context cache by authenticated account scope", () => {
    const storage = new Map<string, string>();
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
    try {
      persistContextUsage("web:shared", "user-a", { percent: 10 });
      persistContextUsage("web:shared", "user-b", { percent: 90 });

      expect(restoreContextUsage("web:shared", "user-a")).toMatchObject({ percent: 10 });
      expect(restoreContextUsage("web:shared", "user-b")).toMatchObject({ percent: 90 });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "window", originalDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  test("does not read or write context cache before authenticated scope is ready", () => {
    const storage = new Map<string, string>();
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
    try {
      setContextUserScope(null);
      persistContextUsage("web:pending", "", { percent: 50 });
      expect(restoreContextUsage("web:pending", "")).toBeNull();
      expect(storage.size).toBe(0);

      setContextUserScope("user-a");
      persistContextUsage("web:pending", "user-a", { percent: 25 });
      expect(restoreContextUsage("web:pending", "user-a")).toMatchObject({ percent: 25 });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "window", originalDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  test("emits scope-ready only for an authenticated scope change", () => {
    const events: string[] = [];
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const win = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: win });
    win.addEventListener("piclaw:context-scope-ready", (event) => {
      events.push((event as CustomEvent).detail.userScope);
    });
    try {
      setContextUserScope(null);
      setContextUserScope("user-a");
      setContextUserScope("user-a");
      setContextUserScope("user-b");
      expect(events).toEqual(["user-a", "user-b"]);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "window", originalDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
});
