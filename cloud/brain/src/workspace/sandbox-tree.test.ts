import { describe, expect, test } from "bun:test";
import { handleWorkspaceRoutes } from "./routes.ts";

describe("handleWorkspaceRoutes", () => {
  test("returns null for unrelated paths", async () => {
    const res = await handleWorkspaceRoutes(new Request("http://localhost/health"), "/health");
    expect(res).toBeNull();
  });

  test("visibility stub ok", async () => {
    const res = await handleWorkspaceRoutes(
      new Request("http://localhost/workspace/visibility", { method: "POST" }),
      "/workspace/visibility",
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true });
  });

  test("index-status stub ready", async () => {
    const res = await handleWorkspaceRoutes(
      new Request("http://localhost/workspace/index-status"),
      "/workspace/index-status",
    );
    const body = await res?.json();
    expect(body?.state).toBe("ready");
  });
});
