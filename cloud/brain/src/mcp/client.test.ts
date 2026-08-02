import { afterEach, describe, expect, test } from "bun:test";
import {
  buildModernMcpHeaders,
  parseMcpToolName,
  resetMcpClientsForTests,
} from "./client.ts";

describe("modern MCP client helpers", () => {
  afterEach(() => resetMcpClientsForTests());

  test("adds mandatory 2026 request headers for a tool call", () => {
    expect(buildModernMcpHeaders("tools/call", "web_search")).toMatchObject({
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "web_search",
    });
  });

  test("does not allow configured headers to override SDK-owned MCP headers", () => {
    const configured = { "Mcp-Method": "bad", Authorization: "Bearer token" };
    const headers = { ...configured, ...buildModernMcpHeaders("tools/call", "web_search") };
    expect(headers["Mcp-Method"]).toBe("tools/call");
    expect(headers.Authorization).toBe("Bearer token");
  });

  test("parses namespaced MCP tool names", () => {
    expect(parseMcpToolName("mcp__exa__web_search_exa")).toEqual({
      server: "exa",
      toolName: "web_search_exa",
    });
  });
});
