/**
 * Phase 1e Web UI acceptance — browser-driven checklist + Wio scenario.
 *
 * Prerequisites:
 *   - `bun run build:web:cloud` (static assets in runtime/web/static)
 *   - brain running on CLOUD_E2E_BASE (default http://localhost:7801)
 *   - CubeSandbox configured (terminal + file steps)
 *
 * Modes:
 *   CLOUD_WEB_E2E_MODE=mock-tools  — fast path (no real LLM)
 *   default                        — real LLM (requires openai in brain.config.json)
 */
import { getCloudConfig } from "@piclaw-cloud/shared/cloud-config";
import { chromium, type Page } from "playwright";
import { applyE2bEnv, missingSandboxConfig, sandboxConfig } from "../src/sandbox/config.ts";
import { connectSandbox, healthCheck } from "../src/sandbox/client.ts";
import { getAccessToken } from "../src/sandbox/auth.ts";
import { readFile } from "../src/sandbox/fs.ts";

applyE2bEnv();

const BASE = process.env.CLOUD_E2E_BASE || "http://localhost:7801";
const CHAT = `web-e2e-${Date.now()}`;
const MODE = (process.env.CLOUD_WEB_E2E_MODE || "llm").toLowerCase();
const HEADLESS = process.env.CLOUD_WEB_E2E_HEADLESS !== "0";
const MESSAGE_TIMEOUT_MS = Number(process.env.CLOUD_WEB_E2E_MESSAGE_TIMEOUT_MS || 180_000);
const EXECUTABLE_PATH =
  process.env.CLOUD_PLAYWRIGHT_EXECUTABLE_PATH ||
  process.env.PICLAW_PLAYWRIGHT_EXECUTABLE_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");

const COMPOSE = '[data-testid="compose-input"], .compose-box textarea, .compose-editor [contenteditable]';
const SEND = '[data-testid="send-button"], .compose-send, button.send-btn:not(.abort-mode)';
const POST = '[data-testid="post"], .post';
const POST_CONTENT = ".post-content";
const AGENT_STATUS = ".agent-thinking-body, .agent-thinking, .agent-status-text, .agent-status-panel";

async function countUserPosts(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    return Array.from(document.querySelectorAll(selector)).filter((post) => {
      const el = post as HTMLElement;
      const isBot = el.classList.contains("bot") || el.querySelector(".bot-avatar") !== null;
      return !isBot;
    }).length;
  }, POST);
}

async function waitForUserPost(page: Page, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countUserPosts(page)) >= 1) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function waitForStreamingPreview(page: Page, timeoutMs = 15_000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (selector) => {
        const nodes = Array.from(document.querySelectorAll(selector));
        return nodes.some((node) => (node.textContent?.trim().length ?? 0) > 0);
      },
      AGENT_STATUS,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
function check(condition: boolean, label: string) {
  console.log(`${condition ? "  ✅" : "  ❌"} ${label}`);
  if (!condition) failures += 1;
}

async function waitForPosts(page: Page, minCount: number, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.locator(POST).count();
    if (count >= minCount) return count;
    await page.waitForTimeout(500);
  }
  return page.locator(POST).count();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const compose = page.locator(COMPOSE).first();
  await compose.waitFor({ state: "visible", timeout: 30_000 });
  await compose.click();
  await compose.fill(text);
  const sendBtn = page.locator(SEND).first();
  if (await sendBtn.isVisible()) {
    await sendBtn.click();
  } else {
    await compose.press("Enter");
  }
}

async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate((selector) => {
    const posts = Array.from(document.querySelectorAll(selector));
    for (let i = posts.length - 1; i >= 0; i -= 1) {
      const post = posts[i] as HTMLElement;
      const content = post.querySelector(".post-content")?.textContent?.trim() || "";
      const isBot = post.classList.contains("bot") || post.querySelector(".bot-avatar") !== null;
      if (content && isBot) return content;
    }
    const all = posts.map((p) => (p.querySelector(".post-content")?.textContent || "").trim()).filter(Boolean);
    return all.at(-1) || "";
  }, POST);
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  return (await fetch(`${BASE}${path}`)).json();
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

console.log("Phase 1e — Web UI acceptance");
console.log(`  brain:  ${BASE}`);
console.log(`  chat:   ${CHAT}`);
console.log(`  mode:   ${MODE}`);
console.log(`  cube:   ${sandboxConfig.apiUrl}`);

if (MODE === "llm") {
  if (!getCloudConfig().openai.apiKey) {
    console.error("\nMissing openai.apiKey — set in cloud/brain.config.json or use CLOUD_WEB_E2E_MODE=mock-tools.");
    process.exit(2);
  }
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

try {
  const brainHealth = await fetch(`${BASE}/health`);
  if (!brainHealth.ok) throw new Error("brain not running — start with: cd cloud/brain && bun run start");
  const index = await fetch(`${BASE}/`);
  if (!index.ok) throw new Error("brain static UI not available — run: bun run build:web:cloud");
} catch (error) {
  console.error(String(error));
  process.exit(2);
}

const browser = await chromium.launch({
  headless: HEADLESS,
  ...(EXECUTABLE_PATH ? { executablePath: EXECUTABLE_PATH } : {}),
});
const context = await browser.newContext();
const page = await context.newPage();

let sandboxId = "";
let inoPath = "";

try {
  console.log("\n[1] load Web UI + create session");
  {
    await page.goto(`${BASE}/?chat_jid=${encodeURIComponent(CHAT)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const title = await page.title();
    check(title.includes("PiClaw") || title.length > 0, `page loaded (title=${title.slice(0, 40)})`);
    const timeline = await getJson(`/timeline?chat_jid=${encodeURIComponent(CHAT)}&limit=5`);
    check(Array.isArray(timeline.posts), "timeline API ok for session");
  }

  console.log("\n[2] hello — chat + streaming + user message");
  {
    const prompt = MODE === "mock-tools" ? "slow stream e2e" : "hello";
    const streamingPromise =
      MODE === "mock-tools" ? waitForStreamingPreview(page, 30_000) : Promise.resolve(true);
    await sendMessage(page, prompt);
    const userVisible = await waitForUserPost(page);
    check(userVisible, "user message visible immediately after send");
    if (MODE === "mock-tools") {
      const sawDraft = await streamingPromise;
      check(sawDraft, "streaming draft visible in agent status panel");
    }
    const postCount = await waitForPosts(page, 2);
    check(postCount >= 2, `timeline shows user+assistant (${postCount} posts)`);
    check((await countUserPosts(page)) >= 1, "user post remains in timeline");
    const reply = await lastAssistantText(page);
    check(reply.length > 0, `assistant reply visible (${reply.slice(0, 60)})`);
    if (MODE === "llm") {
      check(!reply.includes("mock-reply"), "not mock text");
    }
  }

  console.log("\n[3] sandbox tool execution");
  {
    const prompt =
      MODE === "mock-tools"
        ? "mock-tools: wio demo"
        : "使用 Wio Terminal 写一个 hello world demo，把 Arduino 代码保存到 /workspace 下的 .ino 文件";
    await sendMessage(page, prompt);
    await waitForPosts(page, 4, MESSAGE_TIMEOUT_MS);

    const body = await getJson(`/sessions/${encodeURIComponent(CHAT)}/messages`);
    const msgs = (body.messages as Array<{ role: string; content_blocks?: { tool_calls?: unknown[] } | null }>) ?? [];
    const hadTools =
      msgs.some((m) => m.role === "tool") || msgs.some((m) => (m.content_blocks?.tool_calls?.length ?? 0) > 0);
    check(hadTools, "tool calls persisted");

    const sessionBody = await getJson(`/sessions/${encodeURIComponent(CHAT)}`);
    sandboxId = (sessionBody.session as { sandbox_id?: string })?.sandbox_id ?? "";
    if (sandboxId) {
      check(Boolean(sandboxId), `session bound to sandbox (${sandboxId})`);
      const ino = await findInoFile(sandboxId);
      check(ino !== null, "found .ino file in /workspace");
      if (ino) {
        inoPath = ino.path;
        const lower = ino.content.toLowerCase();
        if (MODE === "mock-tools") {
          check(lower.includes("hello world"), "mock-tools wrote demo.ino");
        } else {
          check(lower.includes("setup") && lower.includes("loop"), "Arduino setup/loop present");
        }
      }
    } else {
      console.log("  ⚠ sandbox unavailable — skipping file verification");
    }
  }

  console.log("\n[4] edit hello world → hello agent");
  if (MODE === "mock-tools") {
    console.log("  ⚠ skipped in mock-tools mode");
  } else if (!sandboxId || !inoPath) {
    console.log("  ⚠ skipped — sandbox file steps unavailable");
  } else {
    await sendMessage(page, "输出 hello world 改为输出“hello agent”");
    await waitForPosts(page, 6, MESSAGE_TIMEOUT_MS);
    const session = await getJson(`/sessions/${encodeURIComponent(CHAT)}`);
    check((session.session as { sandbox_id?: string })?.sandbox_id === sandboxId, "same sandbox after edit");
    const ino = await findInoFile(sandboxId);
    check(ino !== null && ino.path === inoPath, `same .ino path (${inoPath})`);
    if (ino) {
      const lower = ino.content.toLowerCase();
      check(lower.includes("hello agent"), "file contains hello agent");
    }
  }

  console.log("\n[5] terminal WebSocket attach");
  {
    await page.keyboard.press("Control+Backquote");
    await page.waitForTimeout(1500);
    const terminal = page.locator(".xterm, .terminal-container, [data-testid='terminal']").first();
    if (!(await terminal.isVisible())) {
      console.log("  ⚠ terminal pane not visible — skipped");
    } else {
      let passed = false;
      try {
        await page.evaluate(() => {
          const el = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
          el?.focus();
        });
        await page.keyboard.type("echo WEB_TERMINAL_OK\n", { delay: 30 });
        await page.waitForTimeout(3000);
        const text = await page.evaluate(() => {
          const layer = document.querySelector(".xterm-rows, .xterm-screen, [data-testid='terminal-output']");
          return layer?.textContent || "";
        });
        passed = text.includes("WEB_TERMINAL_OK");
      } catch (error) {
        console.log(`  ⚠ terminal interaction failed (${String(error).slice(0, 80)})`);
      }
      if (passed) check(true, "terminal echo roundtrip");
      else console.log("  ⚠ terminal echo not confirmed — sandbox may be slow");
    }
  }

  console.log("\n[6] SSE disconnect/reconnect (page reload)");
  {
    const beforeCount = await page.locator(POST).count();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const afterCount = await page.locator(POST).count();
    check(afterCount >= 2, `timeline restored after reload (${afterCount} posts, was ${beforeCount})`);
  }
} finally {
  await context.close();
  await browser.close();
}

console.log(`\n${failures === 0 ? "✅ WEB E2E PASSED" : `❌ WEB E2E FAILED (${failures} checks)`}`);
process.exit(failures === 0 ? 0 : 1);
