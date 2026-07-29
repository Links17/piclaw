import { describe, expect, test } from "bun:test";
import { serveStaticRequest } from "../src/static.ts";

describe("serveStaticRequest", () => {
  test("serves index.html at root", async () => {
    const res = serveStaticRequest(new Request("http://localhost:7801/"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toContain("text/html");
  });

  test("rejects path traversal", async () => {
    const res = serveStaticRequest(new Request("http://localhost:7801/static/../package.json"));
    expect(res).toBeNull();
  });

  test("returns null for API paths", async () => {
    const res = serveStaticRequest(new Request("http://localhost:7801/health"));
    expect(res).toBeNull();
  });
});
