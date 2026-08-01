/**
 * Real LLM + Sandbox acceptance — three-step Wio Terminal scenario.
 *
 * Requires:
 *   - brain running (CLOUD_E2E_BASE, default http://localhost:7801)
 *   - openai config in cloud/brain.config.json (or POC_OPENAI_* env)
 *   - CubeSandbox cluster (sandbox section in config)
 */
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import { ensureE2eSession } from "./e2e-session.ts";
import { applyE2bEnv, missingSandboxConfig, sandboxConfig } from "../src/sandbox/config.ts";
import { connectSandbox, healthCheck } from "../src/sandbox/client.ts";
import { getAccessToken } from "../src/sandbox/auth.ts";
import { readFile } from "../src/sandbox/fs.ts";
import { executableHelloLines, hasLegacyHelloOutput } from "../src/e2e/arduino-output.ts";

applyE2bEnv();

const EXAMPLE_CONFIG = new URL("../../brain.config.example.json", import.meta.url).pathname;
process.env.CLOUD_CONFIG_PATH ||= EXAMPLE_CONFIG;

const BASE = process.env.CLOUD_E2E_BASE || "http://localhost:7801";
const CHAT = `llm-e2e-${Date.now()}`;

interface MessageRow {
  id: number;
  role: string;
  content: string;
  content_blocks?: { tool_calls?: unknown[]; tool_call_id?: string } | null;
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

async function findInoFile(sandboxId: string): Promise<{ path: string; content: string } | null> {
  if (!sandboxId) return null;
  try {
    const sbx = await connectSandbox(sandboxId);
    const result = await sbx.commands.run("find /workspace -name '*.ino' -type f 2>/dev/null | head -1");
    const path = result.stdout.trim();
    if (!path) return null;
    const content = await readFile(sbx, path);
    return { path, content: String(content) };
  } catch (error) {
    console.log(`  ⚠ sandbox file lookup failed (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

async function preflightSandbox(): Promise<boolean> {
  try {
    const { createSandbox, createWorkspaceVolume } = await import("../src/sandbox/client.ts");
    const volume = await createWorkspaceVolume(`llm-sandbox-preflight-${Date.now()}`);
    const sbx = await createSandbox({ volumeId: volume });
    const id = sbx.sandboxId;
    await sbx.kill().catch(() => {});
    console.log(`  sandbox preflight ok (${id})`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ⚠ sandbox preflight failed — file steps will fail (${message.slice(0, 120)})`);
    return false;
  }
}

function hasToolCalls(messages: MessageRow[]): boolean {
  return messages.some(
    (m) => m.role === "assistant" && (m.content_blocks?.tool_calls?.length ?? 0) > 0,
  ) || messages.some((m) => m.role === "tool");
}

function lastAssistantText(messages: MessageRow[]): string {
  const assistants = messages.filter((m) => m.role === "assistant" && !(m.content_blocks?.tool_calls?.length));
  return assistants.at(-1)?.content ?? "";
}

console.log("LLM + Sandbox E2E");
console.log(`  brain: ${BASE}`);
console.log(`  chat:  ${CHAT}`);
console.log(`  cube:  ${sandboxConfig.apiUrl}`);

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
    const code = await proc.exited;
    if (code !== 0) console.log("  ⚠ quota cleanup exited", code);
  } catch (error) {
    console.log(`  ⚠ quota cleanup skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

if (!getCloudConfig().openai.apiKey || getCloudConfig().openai.apiKey === "sk-your-key-here") {
  console.error("\nMissing real openai.apiKey — set CLOUD_OPENAI_API_KEY or POC_OPENAI_API_KEY.");
  process.exit(2);
}
if (!getCloudConfig().openai.baseUrl) {
  console.error("\nMissing openai.baseUrl in cloud/brain.config.example.json or CLOUD_OPENAI_BASE_URL.");
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
  if (!brainHealth.ok) throw new Error("brain not running");
} catch (error) {
  console.error(String(error));
  process.exit(2);
}

let inoPath = "";
let sandboxId = "";

console.log("\n[1] hello — LLM reply");
{
  await ensureE2eSession(BASE, CHAT, "llm-e2e");
  await postAgent("hello");
  const messages = await getMessages();
  const reply = lastAssistantText(messages);
  check(reply.length > 0, `non-empty assistant reply (${reply.slice(0, 60)})`);
  check(!reply.includes("mock-reply"), "not mock text");
}

console.log("\n[2] Wio Terminal hello world demo — sandbox Arduino file");
{
  await postAgent("使用 Wio Terminal 写一个 hello world demo，把 Arduino 代码保存到 /workspace 下的 .ino 文件");
  const messages = await getMessages();
  check(hasToolCalls(messages), "LLM invoked sandbox tools");

  if (!sandboxReady) {
    check(false, "sandbox cluster can create VMs (ENOSPC or 502 — free disk on CubeSandbox node)");
  } else {
    const session = await getSession();
    sandboxId = session.sandbox_id ?? "";
    check(Boolean(sandboxId), `session bound to sandbox (${sandboxId})`);

    const ino = await findInoFile(sandboxId);
    check(ino !== null, "found .ino file in /workspace");
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

console.log("\n[3] edit hello world → hello agent");
{
  if (!sandboxReady || !sandboxId || !inoPath) {
    console.log("  ⚠ skipped — sandbox file steps unavailable");
  } else {
    const beforeSession = sandboxId;
    await postAgent(
      `请读取并修改 ${inoPath}。把所有非注释、用户可见的 “hello world” 或 “hello, world” 输出替换成恰好 “hello agent”，必须同时覆盖 Serial、TFT、LCD 等所有输出调用。保留 setup() 和 loop()。保存后重新读取文件，确认所有可执行输出均不再含 hello world。`,
    );
    const messages = await getMessages();
    check(hasToolCalls(messages.filter((m) => m.id > 0)), "edit turn used tools");

    const session = await getSession();
    check(session.sandbox_id === beforeSession, "same sandbox_id after edit");

    const ino = await findInoFile(session.sandbox_id!);
    check(ino !== null && ino.path === inoPath, `same .ino path (${inoPath})`);
    if (ino) {
      const lower = ino.content.toLowerCase();
      check(lower.includes("hello agent"), "file contains hello agent");
      const helloLines = executableHelloLines(ino.content);
      if (hasLegacyHelloOutput(ino.content)) {
        console.log("  legacy executable hello lines:", helloLines.filter((line) => /\bhello(?:,)?\s+world\b/i.test(line)));
      }
      check(!hasLegacyHelloOutput(ino.content), "hello world removed from executable output");
    }

    const reply = lastAssistantText(messages);
    check(reply.length > 0, `assistant acknowledged edit (${reply.slice(0, 80)})`);
  }
}

console.log(failures === 0 ? "\nLLM + SANDBOX E2E PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
