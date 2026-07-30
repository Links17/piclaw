import { describe, expect, it } from "bun:test";
import { mapInternalToSse } from "@piclaw-cloud/shared/sse-events";

describe("skill tool SSE visibility", () => {
  it("maps skill tool_start with skill name detail", () => {
    const envelope = mapInternalToSse(
      { chatJid: "sess-1" },
      { type: "tool_start", name: "skill", toolCallId: "call-1", replica: "r1", detail: "platform" },
    );
    expect(envelope?.event).toBe("agent_status");
    expect(envelope?.data.detail).toBe("platform");
    expect(envelope?.data.title).toBe("skill");
  });
});
