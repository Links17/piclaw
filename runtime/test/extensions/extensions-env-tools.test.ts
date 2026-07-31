import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";

import { createTempWorkspace, importFresh, setEnv } from "../helpers.js";
import { createFakeExtensionApi } from "./fake-extension-api.js";

describe("env-tools extension", () => {
  let ws: ReturnType<typeof createTempWorkspace>;
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    ws = createTempWorkspace("piclaw-env-tools-");
    restoreEnv = setEnv({
      PICLAW_WORKSPACE: ws.workspace,
      PICLAW_STORE: ws.store,
      PICLAW_DATA: ws.data,
      BAR: "copied-value",
    });
    delete process.env.TEST_ENV_TOOL_VAR;
    delete process.env.KEEP_ME;
  });

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
    delete process.env.TEST_ENV_TOOL_VAR;
    delete process.env.KEEP_ME;
    ws.cleanup();
  });

  async function getTool() {
    const { envTools } = await importFresh<typeof import("../src/extensions/env-tools.js")>("../src/extensions/env-tools.js");
    const fake = createFakeExtensionApi();
    envTools(fake.api);
    return fake.tools.get("env");
  }

  test("does not advertise an invalid strict schema to Codex", async () => {
    const tool = await getTool();
    expect(tool.constrainedSampling).toBeUndefined();
    expect((convertResponsesTools([tool], { strict: null, supportsStrictMode: true })[0] as any).strict).toBeNull();
  });

  test("get without a name lists managed variable names only", async () => {
    const tool = await getTool();

    const empty = await tool.execute("env-1", { action: "get" });
    expect(empty.content[0].text).toContain("No managed workspace environment variables found");

    await tool.execute("env-2", { action: "set", name: "TEST_ENV_TOOL_VAR", value: "abc" });
    const listed = await tool.execute("env-3", { action: "get" });
    expect(listed.content[0].text).toContain("TEST_ENV_TOOL_VAR");
    expect(listed.content[0].text).not.toContain("abc");
  });

  test("set persists the managed env, updates process.env immediately, and get returns the stored value", async () => {
    const tool = await getTool();

    const setResult = await tool.execute("env-4", { action: "set", name: "TEST_ENV_TOOL_VAR", value: "hello world" });
    expect(setResult.details.applied_immediately).toBe(true);
    expect(process.env.TEST_ENV_TOOL_VAR).toBe("hello world");

    const envScript = readFileSync(`${ws.workspace}/.env.sh`, "utf8");
    expect(envScript).toContain("# >>> piclaw env tool >>>");
    expect(envScript).toContain("export TEST_ENV_TOOL_VAR='hello world'");

    const stateJson = JSON.parse(readFileSync(`${ws.workspace}/.seeed/env-tool.json`, "utf8"));
    expect(stateJson).toEqual({ TEST_ENV_TOOL_VAR: "hello world" });

    const getResult = await tool.execute("env-5", { action: "get", name: "TEST_ENV_TOOL_VAR" });
    expect(getResult.content[0].text).toBe("hello world");
    expect(getResult.details.source).toBe("managed");
    expect(getResult.details.persisted).toBe(true);
  });

  test("set can copy from an existing environment variable via $NAME", async () => {
    const tool = await getTool();

    const setResult = await tool.execute("env-6", { action: "set", name: "TEST_ENV_TOOL_VAR", value: "$BAR" });
    expect(setResult.details.copied_from_env).toBe("BAR");
    expect(process.env.TEST_ENV_TOOL_VAR).toBe("copied-value");

    const getResult = await tool.execute("env-7", { action: "get", name: "TEST_ENV_TOOL_VAR" });
    expect(getResult.content[0].text).toBe("copied-value");
  });

  test("clear removes one managed variable while preserving user content outside the managed block", async () => {
    writeFileSync(`${ws.workspace}/.env.sh`, "export KEEP_ME='yes'\n", "utf8");
    const tool = await getTool();

    await tool.execute("env-8", { action: "set", name: "TEST_ENV_TOOL_VAR", value: "abc" });
    expect(process.env.TEST_ENV_TOOL_VAR).toBe("abc");

    const clearResult = await tool.execute("env-9", { action: "clear", name: "TEST_ENV_TOOL_VAR" });
    expect(clearResult.details.cleared).toBe(true);
    expect(process.env.TEST_ENV_TOOL_VAR).toBeUndefined();

    const envScript = readFileSync(`${ws.workspace}/.env.sh`, "utf8");
    expect(envScript).toContain("export KEEP_ME='yes'");
    expect(envScript).not.toContain("TEST_ENV_TOOL_VAR");
  });

  test("clear without a name clears all managed variables", async () => {
    const tool = await getTool();

    await tool.execute("env-10", { action: "set", name: "TEST_ENV_TOOL_VAR", value: "abc" });
    await tool.execute("env-11", { action: "set", name: "KEEP_ME", value: "def" });
    const clearAll = await tool.execute("env-12", { action: "clear" });

    expect(clearAll.details.cleared).toBe(true);
    expect(process.env.TEST_ENV_TOOL_VAR).toBeUndefined();
    expect(process.env.KEEP_ME).toBeUndefined();

    const getAll = await tool.execute("env-13", { action: "get" });
    expect(getAll.details.count).toBe(0);
  });
});
