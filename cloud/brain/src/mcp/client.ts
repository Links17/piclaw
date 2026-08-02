/** MCP 2026-07-28 client registry backed by the official SDK. */
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ToolDefinition } from "../tools/schemas.ts";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const MAX_MCP_OUTPUT_CHARS = 32_000;
const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  toolNames?: string[];
  timeoutMs?: number;
}

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

interface RegisteredMcpTool {
  server: string;
  originalName: string;
  definition: ToolDefinition;
  outputSchema?: Record<string, unknown>;
}

interface McpConnection {
  client: Client;
  allowedToolNames: ReadonlySet<string> | null;
}

const registeredTools: RegisteredMcpTool[] = [];
const connections = new Map<string, McpConnection>();
let initialized = false;

function mcpToolName(server: string, toolName: string): string {
  return `mcp__${server}__${toolName}`;
}

export function parseMcpToolName(name: string): { server: string; toolName: string } | null {
  const match = /^mcp__([^_][\w-]*)__(.+)$/.exec(name);
  if (!match) return null;
  return { server: match[1]!, toolName: match[2]! };
}

export function buildModernMcpHeaders(method: string, name?: string): Record<string, string> {
  return {
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": name } : {}),
  };
}

function mcpMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "piclaw-cloud", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: { "io.modelcontextprotocol/tasks": {} },
    },
  };
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
  const timeoutMs = Math.max(1_000, server.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    protocolVersion: MCP_PROTOCOL_VERSION,
    requestInit: {
      headers: {
        ...(server.headers ?? {}),
      },
    },
  });
  const client = new Client(
    { name: "piclaw-cloud", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
  );
  await client.connect(transport);
  const payload = await client.listTools({ _meta: mcpMeta() } as never, {
    timeout: timeoutMs,
  } as never);
  const allowedToolNames = server.toolNames?.length ? new Set(server.toolNames) : null;
  connections.set(server.name, { client, allowedToolNames });
  for (const tool of payload.tools ?? []) {
    if (allowedToolNames && !allowedToolNames.has(tool.name)) continue;
    registeredTools.push({
      server: server.name,
      originalName: tool.name,
      definition: {
        type: "function",
        function: {
          name: mcpToolName(server.name, tool.name),
          description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
          parameters: tool.inputSchema as Record<string, unknown> ?? { type: "object", properties: {} },
        },
      } satisfies ToolDefinition,
      outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
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
  const connection = connections.get(parsed.server);
  if (!connection) return { output: `Unknown MCP server: ${parsed.server}`, isError: true };
  if (connection.allowedToolNames && !connection.allowedToolNames.has(parsed.toolName)) {
    return { output: `MCP tool is not permitted: ${name}`, isError: true };
  }
  try {
    const result = await connection.client.callTool({
      name: parsed.toolName,
      arguments: args,
      _meta: mcpMeta(),
    } as never);
    const structured = "structuredContent" in result ? result.structuredContent : undefined;
    const text = (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)))
      .join("\n");
    const output = text || (structured === undefined ? "(empty MCP result)" : JSON.stringify(structured));
    return {
      output: output.length > MAX_MCP_OUTPUT_CHARS
        ? `${output.slice(0, MAX_MCP_OUTPUT_CHARS)}\n...[truncated]`
        : output,
      isError: result.isError === true,
    };
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), isError: true };
  }
}

export function resetMcpClientsForTests(): void {
  initialized = false;
  registeredTools.length = 0;
  for (const connection of connections.values()) void connection.client.close();
  connections.clear();
}
