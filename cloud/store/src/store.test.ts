import { describe, expect, test } from "bun:test";
import { mapInternalToWeb } from "@piclaw-cloud/shared/sse-events";

describe("@piclaw-cloud/shared sse-events", () => {
  test("maps delta to agent_draft_delta", () => {
    const mapped = mapInternalToWeb("s1", { type: "delta", text: "hi", replica: "A" });
    expect(mapped).toEqual({ type: "agent_draft_delta", delta: "hi" });
  });

  test("maps followup_queued", () => {
    const mapped = mapInternalToWeb("s1", { type: "followup_queued", content: "next" });
    expect(mapped).toEqual({ type: "agent_followup_queued", content: "next" });
  });
});
