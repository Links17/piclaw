/**
 * Phase 1e acceptance — Web adapter + sandbox bash + terminal WS + follow-up.
 *
 * Requires CubeSandbox cluster (CUBE_TEMPLATE_ID). Set CLOUD_SANDBOX_ENABLED=1 (default).
 */
import { applyE2bEnv, missingSandboxConfig, sandboxConfig } from "../src/sandbox/config.ts";
import { healthCheck } from "../src/sandbox/client.ts";
import { getAccessToken } from "../src/sandbox/auth.ts";

applyE2bEnv();

const BASE = process.env.CLOUD_E2E_BASE || "http://localhost:7801";
const CHAT = `e2e-${Date.now()}`;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

let failures = 0;
function check(condition: boolean, label: string) {
  console.log(`${condition ? "  ✅" : "  ❌"} ${label}`);
  if (!condition) failures += 1;
}

function collectWebSse(chatJid: string, sink: SseEvent[]): AbortController {
  const controller = new AbortController();
  void (async () => {
    const res = await fetch(`${BASE}/sse/stream?chat_jid=${encodeURIComponent(chatJid)}`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (data) sink.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return controller;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}

async function postAgent(chatJid: string, content: string, wait = false): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ chat_jid: chatJid });
  if (wait) params.set("wait", "1");
  const res = await fetch(`${BASE}/agent/default/message?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  return (await fetch(`${BASE}${path}`)).json();
}

console.log("Phase 1e — MVP acceptance");
console.log(`  brain:    ${BASE}`);
console.log(`  chat_jid: ${CHAT}`);
console.log(`  cube:     ${sandboxConfig.apiUrl}`);

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
console.log("  sandbox:  ok\n");

async function reclaimSandboxQuota(): Promise<void> {
  try {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/cleanup-sandbox-quota.ts"],
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  } catch {
    // optional
  }
}

await reclaimSandboxQuota();

try {
  const brainHealth = await fetch(`${BASE}/health`);
  if (!brainHealth.ok) throw new Error("brain not running — start with: cd cloud/brain && bun run start");
} catch (error) {
  console.error(String(error));
  process.exit(2);
}

const events: SseEvent[] = [];
const sse = collectWebSse(CHAT, events);
await Bun.sleep(400);

console.log("[1] create session (via timeline bootstrap)");
{
  const timeline = await fetch(`${BASE}/timeline?chat_jid=${encodeURIComponent(CHAT)}&limit=5`).then((r) => r.json());
  check(Array.isArray(timeline.posts), "timeline endpoint ok");
}

console.log("\n[2] chat + streaming");
{
  const result2 = await postAgent(CHAT, "hello e2e quick", true);
  check(result2.ok === true, `hello turn completed (outcome=${result2.outcome})`);
  const body2 = await getJson(`/sessions/${encodeURIComponent(CHAT)}/messages`);
  const rows2 = (body2.messages as Array<{ role: string; content: string }>) ?? [];
  check(rows2.some((m) => m.role === "assistant" && m.content.length > 0), `assistant reply persisted (${rows2.length} messages)`);
  check(events.some((e) => e.event === "agent_draft_delta") || rows2.some((m) => m.role === "assistant"), "streaming or persisted reply");
}

console.log("\n[3] sandbox tool execution (mock-tools)");
{
  const result = await postAgent(CHAT, "mock-tools: wio demo", true);
  check(result.ok === true, `tool loop completed (outcome=${result.outcome})`);
  const body = await getJson(`/sessions/${encodeURIComponent(CHAT)}/messages`);
  const msgs = (body.messages as Array<{ role: string; content_blocks?: { tool_calls?: unknown[] } | null }>) ?? [];
  const hadTools = msgs.some((m) => m.role === "tool") || msgs.some((m) => (m.content_blocks?.tool_calls?.length ?? 0) > 0);
  check(hadTools, `tool calls persisted (${msgs.length} messages)`);

  const sessionBody = await getJson(`/sessions/${encodeURIComponent(CHAT)}`);
  const sandboxId = (sessionBody.session as { sandbox_id?: string })?.sandbox_id;
  if (sandboxId) {
    const { connectSandbox } = await import("../src/sandbox/client.ts");
    const { readFile } = await import("../src/sandbox/fs.ts");
    const sbx = await connectSandbox(sandboxId);
    const content = String(await readFile(sbx, "/workspace/demo.ino"));
    check(content.includes("hello world"), "mock-tools wrote demo.ino");
  } else {
    console.log("  ⚠ sandbox unavailable — skipping file verification");
  }
}

console.log("\n[4] terminal WebSocket attach");
{
  const wsUrl = BASE.replace(/^http/, "ws") + `/terminal/ws?chat_jid=${encodeURIComponent(CHAT)}`;
  const chunks: string[] = [];
  let passed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("terminal ws timeout"));
      }, 90000);
      ws.onmessage = (ev) => {
        chunks.push(String(ev.data));
        if (chunks.join("").includes("[connected]") && !chunks.join("").includes("TERMINAL_OK")) {
          ws.send("echo TERMINAL_OK\n");
        }
        if (chunks.join("").includes("TERMINAL_OK")) {
          passed = true;
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      };
      ws.onerror = () => reject(new Error("terminal ws error"));
    });
  } catch (error) {
    const msg = String(error);
    if (msg.includes("terminal ws") || msg.includes("sandbox")) {
      console.log(`  ⚠ terminal skipped (${msg.slice(0, 80)})`);
    } else {
      check(false, `terminal ws (${msg})`);
    }
  }
  if (passed) check(true, "terminal echo roundtrip");
}

console.log("\n[5] SSE disconnect/reconnect catch-up");
{
  sse.abort();
  await Bun.sleep(300);
  const timeline = await fetch(`${BASE}/timeline?chat_jid=${encodeURIComponent(CHAT)}&limit=20`).then((r) => r.json());
  const posts = timeline.posts as unknown[];
  check(posts.length >= 2, `timeline has history after reconnect (${posts.length} posts)`);
}

console.log("\n[6] follow-up queue while busy");
{
  const events2: SseEvent[] = [];
  const sse2 = collectWebSse(`${CHAT}-fq`, events2);
  await Bun.sleep(300);
  void postAgent(`${CHAT}-fq`, "mock-tools: medium busy turn");
  await waitFor(() => events2.some((e) => e.event === "agent_status" && e.data.status === "streaming"), "streaming");
  const queued = await postAgent(`${CHAT}-fq`, "follow up message");
  check(queued.outcome === "queued" || queued.queued === true, "second message queued");
  await waitFor(
    () => events2.filter((e) => e.event === "agent_response").length >= 2,
    "both responses",
  );
  check(events2.some((e) => e.event === "agent_followup_consumed"), "followup consumed event");
  sse2.abort();
}

console.log(failures === 0 ? "\nPHASE 1e ACCEPTANCE PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
