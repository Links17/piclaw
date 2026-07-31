import { describe, expect, test } from "bun:test";
import { UNTITLED_SESSION_TITLE, sessionToBranchChat } from "./web-adapter.ts";
import { isTemporarySessionTitle } from "@piclaw-cloud/store";

describe("session lifecycle helpers", () => {
  test("UNTITLED_SESSION_TITLE matches store placeholder", () => {
    expect(UNTITLED_SESSION_TITLE).toBe("New chat");
    expect(isTemporarySessionTitle(UNTITLED_SESSION_TITLE)).toBe(true);
  });

  test("sessionToBranchChat uses title for agent_name", () => {
    const branch = sessionToBranchChat({ id: "web:test", title: UNTITLED_SESSION_TITLE });
    expect(branch.agent_name).toBe("New chat");
    expect(branch.chat_jid).toBe("web:test");
    expect(branch.sandbox_id).toBeNull();
  });

  test("sessionToBranchChat exposes sandbox_id when present", () => {
    const branch = sessionToBranchChat({
      id: "web:test",
      title: "Project",
      sandbox_id: "sbx-abc",
    });
    expect(branch.sandbox_id).toBe("sbx-abc");
  });
});
