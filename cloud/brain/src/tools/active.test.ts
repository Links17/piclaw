import { describe, expect, test } from "bun:test";
import {
  activateToolNames,
  getActiveToolNames,
  resetActiveToolNames,
} from "./active.ts";

describe("active tool state", () => {
  test("keeps activated tools isolated by session", () => {
    const available = new Set(["bash", "Agent"]);
    activateToolNames("session-a", ["bash"], available);

    expect([...getActiveToolNames("session-a")]).toEqual(["bash"]);
    expect([...getActiveToolNames("session-b")]).toEqual([]);
  });

  test("reports unknown names without activating them", () => {
    const result = activateToolNames("session-c", ["bash", "missing"], new Set(["bash"]));

    expect(result.activated).toEqual(["bash"]);
    expect(result.unknown).toEqual(["missing"]);
    expect(result.active).toEqual(["bash"]);
  });

  test("reset removes all session activations", () => {
    activateToolNames("session-d", ["bash"], new Set(["bash"]));
    resetActiveToolNames("session-d");

    expect([...getActiveToolNames("session-d")]).toEqual([]);
  });
});
