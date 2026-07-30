/**
 * Real LLM + coding_agent subagent acceptance.
 *
 * Requires:
 *   - brain running (CLOUD_E2E_BASE, default http://localhost:7801)
 *   - openai config in cloud/brain.config.json (or POC_OPENAI_* env)
 *   - CubeSandbox cluster
 *   - subagent.codingWorkerMode=sandbox in config (recommended)
 */
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import { applyE2bEnv, missingSandboxConfig, sandboxConfig } from "../src/sandbox/config.ts";
import { connectSandbox, healthCheck } from "../src/sandbox/client.ts";
import { getAccessToken } from "../src/sandbox/auth.ts";
import { readFile } from "../src/sandbox/fs.ts";

applyE2bEnv();

const BASE = process.env.CLOUD_E2E_BASE || "http://localhost:7801";
const CHAT = `llm-subagent-e2e-${Date.now()}`;
const TARGET_INO = "/workspace/wio_subagent_test.ino";

interface MessageRow {
  id: number;
  role: string;
  content: string;
  content_blocks?: {
    tool_calls?: Array<{ function?: { name?: string } }>;
    tool_name?: string;
  } | null;
}

interface SubagentRunRow {
  id: string;
  agent_type: string;
  status: string;
  summary: string | null;
  artifacts: string[];
}

let failures = 0;
function check(condition: boolean, label: string) {
  console.log(`${condition ? "  ✅" : "  ❌"} ${label}`);
  if (!condition) failures += 1;
}

async function postAgent(content: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/agent/default/message?chat_jid=${encodeURIComponent(CHAT)}&wait=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`POST failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getMessages(): Promise<MessageRow[]> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(CHAT)}/messages`);
  const body = await res.json();
  return body.messages as MessageRow[];
}

async function getSession(): Promise<{ sandbox_id: string | null }> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(CHAT)}`);
  const body = await res.json();
  return body.session as { sandbox_id: string | null };
}

async function getSubagentRuns(): Promise<SubagentRunRow[]> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(CHAT)}/subagents`);
  const body = await res.json();
  return (body.runs as SubagentRunRow[]) ?? [];
}

function hadCodingAgentDelegation(messages: MessageRow[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      (m.content_blocks?.tool_calls?.some((c) => c.function?.name === "coding_agent") ?? false),
  );
}

function codingAgentToolResults(messages: MessageRow[]): Array<Record<string, unknown>> {
  return messages
    .filter((m) => m.role === "tool" && m.content_blocks?.tool_name === "coding_agent")
    .map((m) => {
      try {
        return JSON.parse(m.content) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

function directSandboxToolMessages(messages: MessageRow[]): number {
  const direct = new Set(["bash", "read", "write", "edit"]);
  return messages.filter(
    (m) => m.role === "tool" && direct.has(String(m.content_blocks?.tool_name ?? "")),
  ).length;
}

async function reclaimSandboxQuota(): Promise<void> {
  try {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/cleanup-sandbox-quota.ts"],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        CLOUD_MAX_ACTIVE_SANDBOXES: process.env.CLOUD_MAX_ACTIVE_SANDBOXES || "10",
      },
    });
    await proc.exited;
  } catch {
    // optional
  }
}

async function preflightSandbox(): Promise<boolean> {
  try {
    const { createSandbox } = await import("../src/sandbox/client.ts");
    const sbx = await createSandbox();
    const id = sbx.sandboxId;
    await sbx.kill().catch(() => {});
    console.log(`  sandbox preflight ok (${id})`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ⚠ sandbox preflight failed (${message.slice(0, 120)})`);
    return false;
  }
}

async function readTargetIno(sandboxId: string): Promise<{ path: string; content: string } | null> {
  try {
    const sbx = await connectSandbox(sandboxId);
    for (const path of [TARGET_INO, "/workspace/wio_subagent_test.ino"]) {
      try {
        const content = String(await readFile(sbx, path));
        if (content.trim()) return { path, content };
      } catch {
        // try find fallback
      }
    }
    const found = await sbx.commands.run(
      "find /workspace -name 'wio_subagent_test.ino' -o -name '*subagent*.ino' 2>/dev/null | head -1",
    );
    const path = found.stdout.trim();
    if (!path) return null;
    return { path, content: String(await readFile(sbx, path)) };
  } catch (error) {
    console.log(`  ⚠ ino read failed (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

async function hasWorkerArtifacts(sandboxId: string): Promise<boolean> {
  try {
    const sbx = await connectSandbox(sandboxId);
    const worker = await sbx.commands.run("test -f /workspace/.piclaw/coding-worker.py && echo yes");
    const runs = await sbx.commands.run("ls /workspace/.piclaw/runs 2>/dev/null | head -1");
    return worker.stdout.includes("yes") || runs.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

console.log("LLM + Subagent E2E");
console.log(`  brain:  ${BASE}`);
console.log(`  chat:   ${CHAT}`);
console.log(`  cube:   ${sandboxConfig.apiUrl}`);
console.log(`  worker: ${getCloudConfig().subagent.codingWorkerMode}`);

if (!getCloudConfig().openai.apiKey) {
  console.error("\nMissing openai.apiKey — set in cloud/brain.config.json or POC_OPENAI_API_KEY.");
  process.exit(2);
}
if (!getCloudConfig().openai.baseUrl) {
  console.error("\nMissing openai.baseUrl — set in cloud/brain.config.json or POC_OPENAI_BASE_URL.");
  process.exit(2);
}

const gaps = missingSandboxConfig();
if (gaps.length > 0) {
  console.error(`Missing sandbox config: ${gaps.join(", ")}`);
  process.exit(2);
}

const health = await healthCheck();
if (!health.ok) {
  console.error("CubeAPI unreachable:", health.detail);
  process.exit(2);
}
await getAccessToken();
await reclaimSandboxQuota();
const sandboxReady = await preflightSandbox();

try {
  const brainHealth = await fetch(`${BASE}/health`);
  if (!brainHealth.ok) throw new Error("brain not running — start brain with cloud/brain.config.json");
} catch (error) {
  console.error(String(error));
  process.exit(2);
}

let sandboxId = "";
let inoPath = "";

console.log("\n[1] delegate create — coding_agent + sandbox worker");
{
  await fetch(`${BASE}/timeline?chat_jid=${encodeURIComponent(CHAT)}`);
  await postAgent(
    "请使用 coding_agent 工具完成：在 /workspace 创建 wio_subagent_test.ino，内容为 Wio Terminal hello world sketch（必须含 setup() 和 loop()，Serial 输出 hello world）",
  );

  const messages = await getMessages();
  check(hadCodingAgentDelegation(messages), "main agent invoked coding_agent");

  const results = codingAgentToolResults(messages);
  check(results.some((r) => r.status === "completed"), "coding_agent tool result status=completed");

  const runs = await getSubagentRuns();
  check(
    runs.some((r) => r.agent_type === "coding" && r.status === "completed"),
    `subagent_runs persisted (${runs.length} runs)`,
  );

  check(directSandboxToolMessages(messages) === 0, "main turn has no direct bash/write/edit tool messages");

  if (!sandboxReady) {
    check(false, "sandbox cluster can create VMs");
  } else {
    const session = await getSession();
    sandboxId = session.sandbox_id ?? "";
    check(Boolean(sandboxId), `session bound to sandbox (${sandboxId})`);

    if (sandboxId) {
      const workerOk = await hasWorkerArtifacts(sandboxId);
      check(workerOk, "sandbox has .piclaw worker or run artifacts");

      const ino = await readTargetIno(sandboxId);
      check(ino !== null, "wio_subagent_test.ino exists in /workspace");
      if (ino) {
        inoPath = ino.path;
        const lower = ino.content.toLowerCase();
        check(lower.includes("setup"), "Arduino setup() present");
        check(lower.includes("loop"), "Arduino loop() present");
        check(lower.includes("hello world") || lower.includes("hello, world"), `hello world in file (${ino.path})`);
        console.log(`  file: ${ino.path}`);
      }
    }
  }
}

console.log("\n[2] delegate edit — coding_agent again, same sandbox");
{
  if (!sandboxReady || !sandboxId || !inoPath) {
    console.log("  ⚠ skipped — prior sandbox steps unavailable");
  } else {
    const beforeSandbox = sandboxId;
    const runsBefore = (await getSubagentRuns()).length;

    await postAgent(
      "请再次使用 coding_agent 工具：把 wio_subagent_test.ino 里 Serial/LCD 的 hello world 输出改为 hello agent",
    );

    const messages = await getMessages();
    check(hadCodingAgentDelegation(messages), "edit turn invoked coding_agent");

    const results = codingAgentToolResults(messages);
    check(results.length >= 2 && results.at(-1)?.status === "completed", "second coding_agent completed");

    const runs = await getSubagentRuns();
    check(runs.length >= runsBefore + 1, `subagent_runs grew (${runsBefore} → ${runs.length})`);

    const session = await getSession();
    check(session.sandbox_id === beforeSandbox, "same sandbox_id after subagent edit");

    const ino = await readTargetIno(session.sandbox_id!);
    check(ino !== null, "ino file still present after edit");
    if (ino) {
      const lower = ino.content.toLowerCase();
      check(lower.includes("hello agent"), "file contains hello agent");
      const outputLines = lower
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      check(!outputLines.includes("hello world"), "hello world removed from executable output");
    }

    check(directSandboxToolMessages(messages) === 0, "edit turn has no direct sandbox tool messages in main history");
  }
}

console.log(failures === 0 ? "\nLLM + SUBAGENT E2E PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
