import { readFile, writeFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import { applyUniqueEdit } from "./edit.ts";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "./path.ts";
import { TOOL_NAMES } from "./schemas.ts";

const MAX_OUTPUT_CHARS = 32_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

export interface ToolDispatchResult {
  output: string;
  isError: boolean;
}

export async function dispatchTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolDispatchResult> {
  if (!TOOL_NAMES.has(name)) {
    return { output: `Unknown tool: ${name}`, isError: true };
  }

  try {
    switch (name) {
      case "bash":
        return await runBashTool(sessionId, args);
      case "read":
        return await runReadTool(sessionId, args);
      case "write":
        return await runWriteTool(sessionId, args);
      case "edit":
        return await runEditTool(sessionId, args);
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: message, isError: true };
  }
}

async function runBashTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const command = String(args.command ?? "").trim();
  if (!command) return { output: "command is required", isError: true };
  const sbx = await ensureSandbox(sessionId);
  const wrapped = `cd ${WORKSPACE_ROOT} && ${command}`;
  const result = await sbx.commands.run(wrapped, { timeoutMs: 120_000 });
  const parts = [`$ ${command}`];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) parts.push(result.stderr.trimEnd());
  parts.push(`(exit ${result.exitCode})`);
  return { output: truncate(parts.join("\n")), isError: result.exitCode !== 0 };
}

async function runReadTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const sbx = await ensureSandbox(sessionId);
  const content = await readFile(sbx, path);
  return { output: truncate(String(content)), isError: false };
}

async function runWriteTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const content = String(args.content ?? "");
  const sbx = await ensureSandbox(sessionId);
  await writeFile(sbx, path, content);
  return { output: `Wrote ${content.length} bytes to ${path}`, isError: false };
}

async function runEditTool(sessionId: string, args: Record<string, unknown>): Promise<ToolDispatchResult> {
  const path = resolveWorkspacePath(String(args.path ?? ""));
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const sbx = await ensureSandbox(sessionId);
  const current = await readFile(sbx, path);
  const updated = applyUniqueEdit(String(current), oldString, newString);
  await writeFile(sbx, path, updated);
  return { output: `Edited ${path}`, isError: false };
}
