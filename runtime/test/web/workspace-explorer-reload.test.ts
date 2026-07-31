import { expect, test } from "bun:test";

import {
  applyTruncatedWorkspaceReloads,
  resolveWorkspaceReloadTarget,
} from "../../web/src/ui/workspace-explorer-reload.js";

test("resolveWorkspaceReloadTarget reloads root for top-level files", () => {
  expect(resolveWorkspaceReloadTarget(".")).toEqual({ kind: "root" });
  expect(resolveWorkspaceReloadTarget("demo.ino")).toEqual({ kind: "root" });
});

test("resolveWorkspaceReloadTarget reloads parent dir for nested paths", () => {
  expect(resolveWorkspaceReloadTarget("src/demo.ino")).toEqual({ kind: "subtree", path: "src" });
});

test("applyTruncatedWorkspaceReloads uses loadTree for file updates", () => {
  const calls: string[] = [];
  applyTruncatedWorkspaceReloads(
    [{ path: "wio_terminal_hello_world.ino", truncated: true }],
    {
      loadTree: () => calls.push("tree"),
      loadSubtree: (path) => calls.push(`subtree:${path}`),
      clearRootSignature: () => calls.push("clear"),
    },
  );
  expect(calls).toEqual(["clear", "tree"]);
});

test("applyTruncatedWorkspaceReloads uses loadSubtree for nested updates", () => {
  const calls: string[] = [];
  applyTruncatedWorkspaceReloads(
    [{ path: "src/demo.ino", truncated: true }],
    {
      loadTree: () => calls.push("tree"),
      loadSubtree: (path) => calls.push(`subtree:${path}`),
    },
  );
  expect(calls).toEqual(["subtree:src"]);
});
