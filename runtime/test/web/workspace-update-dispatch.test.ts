import { expect, test } from "bun:test";

import {
  buildWorkspaceUpdateDetailFromPaths,
} from "../../web/src/ui/workspace-update-dispatch.js";

test("buildWorkspaceUpdateDetailFromPaths normalizes workspace paths", () => {
  expect(buildWorkspaceUpdateDetailFromPaths([
    "/workspace/demo.ino",
    "other.ts",
  ])).toEqual({
    updates: [
      { path: "demo.ino", truncated: true },
      { path: "other.ts", truncated: true },
    ],
  });
});

test("buildWorkspaceUpdateDetailFromPaths skips invalid entries", () => {
  expect(buildWorkspaceUpdateDetailFromPaths(["/etc/passwd", "", null])).toEqual({ updates: [] });
});
