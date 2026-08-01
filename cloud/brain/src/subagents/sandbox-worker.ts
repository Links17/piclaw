/**
 * Sandbox coding worker — Python fallback for templates without bun/node.
 * Uploads coding-worker.py and runs an isolated OpenAI tool loop in /workspace.
 */
import { readFile, writeFile } from "../sandbox/fs.ts";
import { ensureSandbox } from "../sandbox/session.ts";
import { WORKSPACE_ROOT } from "../tools/path.ts";
import type { CodingSubagentResult } from "./types.ts";

const PICLAW_DIR = `${WORKSPACE_ROOT}/.seeed`;
const WORKER_PATH = `${PICLAW_DIR}/coding-worker.py`;

export interface SandboxUsageReceipt {
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  status: "success" | "failed" | "timed_out" | "stopped";
}

function sumReceipts(receipts: SandboxUsageReceipt[]) {
  return receipts.reduce((total, receipt) => ({
    inputTokens: total.inputTokens + receipt.inputTokens,
    outputTokens: total.outputTokens + receipt.outputTokens,
    reasoningTokens: total.reasoningTokens + receipt.reasoningTokens,
    cacheReadTokens: total.cacheReadTokens + receipt.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + receipt.cacheWriteTokens,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

export class SandboxWorkerError extends Error {
  readonly receipts: SandboxUsageReceipt[];
  readonly usage: ReturnType<typeof sumReceipts>;
  readonly status: "failed" | "timed_out" | "stopped";

  constructor(message: string, options: {
    receipts: SandboxUsageReceipt[];
    status: "failed" | "timed_out" | "stopped";
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = "SandboxWorkerError";
    this.receipts = options.receipts;
    this.usage = sumReceipts(options.receipts);
    this.status = options.status;
  }
}

export function parseSandboxUsageReceipts(text: string): SandboxUsageReceipt[] {
  const receipts: SandboxUsageReceipt[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const attempt = Number(value.attempt);
      if (!Number.isInteger(attempt) || attempt <= 0) continue;
      receipts.push({
        attempt,
        inputTokens: Math.max(0, Number(value.inputTokens ?? 0)),
        outputTokens: Math.max(0, Number(value.outputTokens ?? 0)),
        reasoningTokens: Math.max(0, Number(value.reasoningTokens ?? 0)),
        cacheReadTokens: Math.max(0, Number(value.cacheReadTokens ?? 0)),
        cacheWriteTokens: Math.max(0, Number(value.cacheWriteTokens ?? 0)),
        status: value.status === "failed"
          ? "failed"
          : value.status === "timed_out"
            ? "timed_out"
            : value.status === "stopped"
              ? "stopped"
              : "success",
      });
    } catch {
      // A process may die mid-append; ignore only the incomplete record.
    }
  }
  return receipts;
}

export function buildCodingWorkerScript(): string {
  return `#!/usr/bin/env python3
import json, os, subprocess, sys, urllib.request

input_path, output_path, usage_receipts_path = sys.argv[1], sys.argv[2], sys.argv[3]
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

def append_usage_receipt(attempt, round_usage, status):
    receipt = {
        "attempt": attempt,
        "inputTokens": round_usage.get("prompt_tokens", 0) or 0,
        "outputTokens": round_usage.get("completion_tokens", 0) or 0,
        "reasoningTokens": (round_usage.get("completion_tokens_details", {}) or {}).get("reasoning_tokens", 0) or 0,
        "cacheReadTokens": (round_usage.get("prompt_tokens_details", {}) or {}).get("cached_tokens", 0) or 0,
        "cacheWriteTokens": 0,
        "status": status,
    }
    with open(usage_receipts_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(receipt) + "\\n")
        f.flush()
        os.fsync(f.fileno())

def write_result(result):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f)

try:
    prompt = task if not constraints else task + "\\n\\nConstraints: " + constraints
    messages = [
        {"role": "system", "content": "You are a coding worker in /workspace. Use tools to complete the task, then reply with a brief summary."},
        {"role": "user", "content": prompt},
    ]
    usage = {"inputTokens": 0, "outputTokens": 0, "reasoningTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0}
    summary = ""
    for attempt in range(1, 9):
        try:
            payload = chat(messages)
        except Exception:
            raise
        round_usage = payload.get("usage", {}) or {}
        append_usage_receipt(attempt, round_usage, "success")
        usage["inputTokens"] += payload.get("usage", {}).get("prompt_tokens", 0)
        usage["outputTokens"] += payload.get("usage", {}).get("completion_tokens", 0)
        details = payload.get("usage", {}).get("prompt_tokens_details", {}) or {}
        completion_details = payload.get("usage", {}).get("completion_tokens_details", {}) or {}
        usage["cacheReadTokens"] += details.get("cached_tokens", 0) or 0
        usage["reasoningTokens"] += completion_details.get("reasoning_tokens", 0) or 0
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
    write_result({"status": "failed", "summary": "", "artifacts": sorted(artifacts), "usage": usage if "usage" in locals() else {}, "error": str(e)})
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
    signal?: AbortSignal;
  },
): Promise<CodingSubagentResult> {
  const sbx = await ensureSandbox(sessionId);
  const runDir = `${PICLAW_DIR}/runs/${runId}`;
  const inputPath = `${runDir}/input.json`;
  const outputPath = `${runDir}/output.json`;
  const receiptsPath = `${runDir}/usage.ndjson`;

  let terminalOutput = "";
  let terminal: Awaited<ReturnType<typeof sbx.pty.create>> | null = null;
  let abortListener: (() => void) | null = null;
  let executionError: unknown;
  try {
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
    const command = `python3 ${WORKER_PATH} ${inputPath} ${outputPath} ${receiptsPath}`;
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("subagent aborted");
    const onData = (chunk: string | Uint8Array) => {
      terminalOutput += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    };
    terminal = await sbx.pty.create({
      cols: 80,
      rows: 24,
      timeoutMs: options.timeoutMs,
      onData,
    });
    if (options.signal) {
      abortListener = () => void terminal?.kill?.();
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
    await sbx.pty.sendInput(terminal.pid, new TextEncoder().encode(`exec ${command}\n`));
    await sbx.pty.connect(terminal.pid, { onData });
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("subagent aborted");
  } catch (error) {
    executionError = error;
  } finally {
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    if (options.signal?.aborted) await terminal?.kill?.().catch(() => {});
  }

  let payload: {
    status?: string;
    summary?: string;
    artifacts?: string[];
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    error?: string;
  } = {};
  let durableReceipts: SandboxUsageReceipt[] = [];
  try {
    durableReceipts = parseSandboxUsageReceipts(String(await readFile(sbx, receiptsPath)));
  } catch {
    durableReceipts = [];
  }
  const durableUsage = sumReceipts(durableReceipts);
  if (executionError) {
    const status = options.signal?.aborted
      ? "stopped"
      : String(executionError).toLowerCase().includes("timeout")
        ? "timed_out"
        : "failed";
    throw new SandboxWorkerError(
      terminalOutput.slice(-2_000) || (executionError instanceof Error
        ? executionError.message
        : String(executionError)),
      { status, receipts: durableReceipts, cause: executionError },
    );
  }

  try {
    const raw = await readFile(sbx, outputPath);
    payload = JSON.parse(String(raw));
  } catch (error) {
    throw new SandboxWorkerError(
      terminalOutput.slice(-2_000) || "sandbox worker output unavailable",
      { status: options.signal?.aborted ? "stopped" : "failed", receipts: durableReceipts, cause: error },
    );
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
      inputTokens: Math.max(payload.usage?.inputTokens ?? 0, durableUsage.inputTokens),
      outputTokens: Math.max(payload.usage?.outputTokens ?? 0, durableUsage.outputTokens),
      reasoningTokens: Math.max(payload.usage?.reasoningTokens ?? 0, durableUsage.reasoningTokens),
      cacheReadTokens: Math.max(payload.usage?.cacheReadTokens ?? 0, durableUsage.cacheReadTokens),
      cacheWriteTokens: Math.max(payload.usage?.cacheWriteTokens ?? 0, durableUsage.cacheWriteTokens),
    },
    usageEntries: durableReceipts.map((receipt) => ({
      invocationId: runId,
      attempt: receipt.attempt,
      stage: "sandbox_worker" as const,
      provider: "openai",
      model: options.openaiModel,
      inputTokens: receipt.inputTokens,
      outputTokens: receipt.outputTokens,
      reasoningTokens: receipt.reasoningTokens,
      cacheReadTokens: receipt.cacheReadTokens,
      cacheWriteTokens: receipt.cacheWriteTokens,
      status: receipt.status,
    })),
    error: payload.error,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
