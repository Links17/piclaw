import { expect, test } from "bun:test";

import { buildWorkspaceVolumeMounts, volumeNameForSession } from "./volume.ts";

test("volumeNameForSession sanitizes chat jid", () => {
  expect(volumeNameForSession("web:b0265fe2-0f05-4c45-bdc8-33b4f0f42a5f"))
    .toBe("web-b0265fe2-0f05-4c45-bdc8-33b4f0f42a5f");
});

test("buildWorkspaceVolumeMounts targets /workspace", () => {
  expect(buildWorkspaceVolumeMounts("vol-abc")).toEqual([
    { name: "vol-abc", path: "/workspace" },
  ]);
});
