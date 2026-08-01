import { describe, expect, test } from "bun:test";
import { ensureDreamTask } from "./ensure-task.ts";

describe("ensureDreamTask", () => {
  test("creates the default session before seeding its internal task", async () => {
    const calls: string[] = [];
    const store = {
      getSession: async () => null,
      createSession: async (id: string) => {
        calls.push(`session:${id}`);
      },
      getScheduledTaskById: async () => null,
      upsertScheduledTask: async () => {
        calls.push("task");
      },
      updateScheduledTask: async () => {},
    };

    await ensureDreamTask("web:default", store);

    expect(calls).toEqual(["session:web:default", "task"]);
  });
});
