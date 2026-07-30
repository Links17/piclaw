/**
 * Minimal MCP client — Streamable HTTP tools/list + tools/call proxy.
 */
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import type { ToolDefinition } from "../tools/schemas.ts";

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

interface RegisteredMcpTool {
  server: string;
  originalName: string;
  definition: ToolDefinition;
}

const registeredTools: RegisteredMcpTool[] = [];
let initialized = false;

function mcpToolName(server: string, toolName: string): string {
  return `mcp__${server}__${toolName}`;
}

function parseMcpToolName(name: string): { server: string; toolName: string } | null {
  const match = /^mcp__([^_][\w-]*)__(.+)$/.exec(name);
  if (!match) return null;
  return { server: match[1]!, toolName: match[2]! };
}

export async function initializeMcpClients(): Promise<void> {
  if (initialized) return;
  initialized = true;
  registeredTools.length = 0;

  const config = getCloudConfig();
  const servers = config.mcp?.servers ?? [];
  for (const server of servers) {
    try {
      await registerMcpServer(server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[mcp] failed to connect ${server.name}: ${message}`);
    }
  }
}

async function registerMcpServer(server: McpServerConfig): Promise<void> {
  const response = await fetch(server.url.replace(/\/$/, ""), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(server.headers ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  if (!response.ok) {
    throw new Error(`tools/list HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
  };
  for (const tool of payload.result?.tools ?? []) {
    registeredTools.push({
      server: server.name,
      originalName: tool.name,
      definition: {
        type: "function",
        function: {
          name: mcpToolName(server.name, tool.name),
          description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      } satisfies ToolDefinition,
    });
  }
}

export function getMcpToolDefinitions(): ToolDefinition[] {
  return registeredTools.map((entry) => entry.definition);
}

export async function invokeMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ output: string; isError: boolean }> {
  const parsed = parseMcpToolName(name);
  if (!parsed) return { output: `Invalid MCP tool name: ${name}`, isError: true };
  const config = getCloudConfig();
  const server = (config.mcp?.servers ?? []).find((entry) => entry.name === parsed.server);
  if (!server) return { output: `Unknown MCP server: ${parsed.server}`, isError: true };

  const response = await fetch(server.url.replace(/\/$/, ""), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(server.headers ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: parsed.toolName, arguments: args },
    }),
  });
  if (!response.ok) {
    return { output: `MCP tools/call HTTP ${response.status}`, isError: true };
  }
  const payload = (await response.json()) as {
    result?: { content?: Array<{ type?: string; text?: string }> };
    error?: { message?: string };
  };
  if (payload.error) {
    return { output: payload.error.message ?? "MCP error", isError: true };
  }
  const text = (payload.result?.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
    .join("\n");
  return { output: text || "(empty MCP result)", isError: false };
}

export function resetMcpClientsForTests(): void {
  initialized = false;
  registeredTools.length = 0;
}
