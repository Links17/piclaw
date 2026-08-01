import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObjectStorage } from "./object-storage.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local object storage", () => {
  test("persists binary objects under stable keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "piclaw-object-storage-"));
    roots.push(root);
    const storage = createObjectStorage({ backend: "local", localDir: root });
    const payload = new Uint8Array([0, 255, 1, 2]);

    await storage.put("sessions/session-1/workspace.tgz", payload, "application/gzip");

    expect(await storage.exists("sessions/session-1/workspace.tgz")).toBe(true);
    expect(await storage.get("sessions/session-1/workspace.tgz")).toEqual(payload);
    await storage.delete("sessions/session-1/workspace.tgz");
    expect(await storage.exists("sessions/session-1/workspace.tgz")).toBe(false);
  });

  test("rejects path traversal keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "piclaw-object-storage-"));
    roots.push(root);
    const storage = createObjectStorage({ backend: "local", localDir: root });

    await expect(storage.put("../escape", new Uint8Array())).rejects.toThrow("object key");
  });

  test("reports that COS requires a configured backend client", async () => {
    const storage = createObjectStorage({ backend: "cos", localDir: "/unused" });

    await expect(storage.put("sessions/a/workspace.tgz", new Uint8Array())).rejects.toThrow(
      "COS object storage is configured but no COS client is available",
    );
  });
});
