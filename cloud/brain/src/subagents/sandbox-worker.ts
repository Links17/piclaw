/**
 * Sandbox coding worker — Python fallback for templates without bun/node.
 * Uploads coding-worker.py and runs an isolated OpenAI tool loop in /workspace.
 */
import { readFile, writeFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import { WORKSPACE_ROOT } from "../tools/path.ts";
import type { CodingSubagentResult } from "./types.ts";

const PICLAW_DIR = `${WORKSPACE_ROOT}/.piclaw`;
const WORKER_PATH = `${PICLAW_DIR}/coding-worker.py`;

export function buildCodingWorkerScript(): string {
  return `#!/usr/bin/env python3
import json, os, subprocess, sys, urllib.request

input_path, output_path = sys.argv[1], sys.argv[2]
with open(input_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

task = cfg.get("task", "")
constraints = cfg.get("constraints")
base = cfg.get("openaiBaseUrl", "").rstrip("/")
api_key = cfg.get("openaiApiKey", "")
model = cfg.get("openaiModel", "gpt-4o-mini")
workspace = "/workspace"
artifacts = set()

tools = [
    {"type": "function", "function": {"name": "bash", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
    {"type": "function", "function": {"name": "read", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "write", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {"name": "edit", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}, "required": ["path", "old_string", "new_string"]}}},
]

def resolve_path(path):
    path = path or ""
    if path.startswith("/"):
        return path
    return os.path.join(workspace, path)

def run_tool(name, args):
    global artifacts
    try:
        if name == "bash":
            cmd = args.get("command", "")
            proc = subprocess.run(["bash", "-lc", f"cd {workspace} && {cmd}"], capture_output=True, text=True, timeout=120)
            out = (proc.stdout or "") + (proc.stderr or "")
            return out + f"\\n(exit {proc.returncode})"
        if name == "read":
            path = resolve_path(args.get("path", ""))
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        if name == "write":
            path = resolve_path(args.get("path", ""))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            content = args.get("content", "")
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            artifacts.add(os.path.relpath(path, workspace) if path.startswith(workspace) else path)
            return f"Wrote {len(content)} bytes to {path}"
        if name == "edit":
            path = resolve_path(args.get("path", ""))
            old = args.get("old_string", "")
            new = args.get("new_string", "")
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
            count = text.count(old)
            if count != 1:
                return f"edit failed: old_string appears {count} times"
            with open(path, "w", encoding="utf-8") as f:
                f.write(text.replace(old, new, 1))
            artifacts.add(os.path.relpath(path, workspace) if path.startswith(workspace) else path)
            return f"Edited {path}"
        return f"unknown tool {name}"
    except Exception as e:
        return str(e)

def chat(messages):
    body = json.dumps({"model": model, "messages": messages, "tools": tools, "tool_choice": "auto"}).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return payload

def write_result(result):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f)

try:
    prompt = task if not constraints else task + "\\n\\nConstraints: " + constraints
    messages = [
        {"role": "system", "content": "You are a coding worker in /workspace. Use tools to complete the task, then reply with a brief summary."},
        {"role": "user", "content": prompt},
    ]
    usage = {"inputTokens": 0, "outputTokens": 0}
    summary = ""
    for _ in range(8):
        payload = chat(messages)
        usage["inputTokens"] += payload.get("usage", {}).get("prompt_tokens", 0)
        usage["outputTokens"] += payload.get("usage", {}).get("completion_tokens", 0)
        msg = payload["choices"][0]["message"]
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            summary = msg.get("content") or "done"
            write_result({"status": "completed", "summary": summary[:4000], "artifacts": sorted(artifacts), "usage": usage})
            sys.exit(0)
        messages.append(msg)
        for call in tool_calls:
            fn = call.get("function", {})
            name = fn.get("name", "")
            args = json.loads(fn.get("arguments") or "{}")
            output = run_tool(name, args)
            messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": output})
    write_result({"status": "failed", "summary": summary, "artifacts": sorted(artifacts), "usage": usage, "error": "max rounds"})
except Exception as e:
    write_result({"status": "failed", "summary": "", "artifacts": sorted(artifacts), "usage": {"inputTokens": 0, "outputTokens": 0}, "error": str(e)})
`;
}

export async function runSandboxPiWorker(
  sessionId: string,
  runId: string,
  options: {
    task: string;
    constraints?: string;
    timeoutMs: number;
    openaiBaseUrl: string;
    openaiApiKey: string;
    openaiModel: string;
  },
): Promise<CodingSubagentResult> {
  const sbx = await ensureSandbox(sessionId);
  const runDir = `${PICLAW_DIR}/runs/${runId}`;
  const inputPath = `${runDir}/input.json`;
  const outputPath = `${runDir}/output.json`;

  await sbx.commands.run(`mkdir -p ${shellQuote(runDir)}`);
  await writeFile(sbx, WORKER_PATH, buildCodingWorkerScript());
  await writeFile(
    sbx,
    inputPath,
    JSON.stringify({
      task: options.task,
      constraints: options.constraints,
      openaiBaseUrl: options.openaiBaseUrl,
      openaiApiKey: options.openaiApiKey,
      openaiModel: options.openaiModel,
      timeoutMs: options.timeoutMs,
    }),
  );

  const command = `python3 ${WORKER_PATH} ${inputPath} ${outputPath}`;
  const result = await sbx.commands.run(command, { timeoutMs: options.timeoutMs });

  let payload: {
    status?: string;
    summary?: string;
    artifacts?: string[];
    usage?: { inputTokens?: number; outputTokens?: number };
    error?: string;
  } = {};

  try {
    const raw = await readFile(sbx, outputPath);
    payload = JSON.parse(String(raw));
  } catch {
    const tail = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-2000);
    return {
      runId,
      status: "failed",
      summary: "",
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      error: tail || `worker exit ${result.exitCode}`,
    };
  }

  const status =
    payload.status === "completed"
      ? "completed"
      : payload.status === "timed_out"
        ? "timed_out"
        : "failed";

  return {
    runId,
    status,
    summary: payload.summary ?? "",
    artifacts: Array.isArray(payload.artifacts) ? payload.artifacts.map(String) : [],
    usage: {
      inputTokens: payload.usage?.inputTokens ?? 0,
      outputTokens: payload.usage?.outputTokens ?? 0,
    },
    error: payload.error,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
