/**
 * Live API isolation acceptance for two authenticated users.
 *
 * Prerequisite: brain is running at CLOUD_E2E_BASE (default localhost:17801)
 * against the PostgreSQL database configured for this environment.
 */
import { sql } from "@piclaw-cloud/store/db";
import { createApiKey, createScheduledTask } from "@piclaw-cloud/store";

const BASE = process.env.CLOUD_E2E_BASE || "http://127.0.0.1:17801";
const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const ownerId = `e2e-owner-${suffix}`;
const otherId = `e2e-other-${suffix}`;
const sessionId = `e2e-isolation-${suffix}`;
const ownerKey = `e2e-owner-key-${suffix}`;
const otherKey = `e2e-other-key-${suffix}`;
const taskId = `e2e-task-${suffix}`;
let mediaId = 0;
let completed = false;

function auth(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function expectStatus(
  path: string,
  key: string,
  expected: number,
  init: RequestInit = {},
): Promise<Response> {
  const baseHeaders = init.body instanceof FormData
    ? { Authorization: `Bearer ${key}` }
    : auth(key);
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...baseHeaders, ...init.headers } });
  if (response.status !== expected) {
    throw new Error(
      `${path} as ${key.startsWith("e2e-owner") ? "owner" : "other"}: expected ${expected}, got ${response.status}: ${await response.text()}`,
    );
  }
  if (path.endsWith("/stream")) {
    await response.body?.cancel();
    await Bun.sleep(25);
  }
  return response;
}

console.log(`Two-user API isolation E2E (${BASE})`);

try {
  await sql`
    INSERT INTO users (id, email, display_name)
    VALUES
      (${ownerId}, ${`${ownerId}@example.test`}, 'E2E Owner'),
      (${otherId}, ${`${otherId}@example.test`}, 'E2E Other')`;
  await createApiKey(ownerId, ownerKey, "two-user-e2e-owner");
  await createApiKey(otherId, otherKey, "two-user-e2e-other");

  const created = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: auth(ownerKey),
    body: JSON.stringify({ id: sessionId, title: "Owner-only session" }),
  });
  if (created.status !== 200) {
    throw new Error(`owner could not create session: ${created.status} ${await created.text()}`);
  }

  await expectStatus(`/sessions/${encodeURIComponent(sessionId)}`, ownerKey, 200);
  await expectStatus(`/sessions/${encodeURIComponent(sessionId)}/messages`, ownerKey, 200);
  await expectStatus(`/sessions/${encodeURIComponent(sessionId)}`, otherKey, 401);
  await expectStatus(`/sessions/${encodeURIComponent(sessionId)}/messages`, otherKey, 401);

  await expectStatus(`/sessions/${encodeURIComponent(sessionId)}/stream`, ownerKey, 200);
  await expectStatus(`/sessions/${encodeURIComponent(sessionId)}/stream`, otherKey, 401);
  await expectStatus(`/sessions/${encodeURIComponent(sessionId)}/subagents`, ownerKey, 200);
  await expectStatus(`/sessions/${encodeURIComponent(sessionId)}/subagents`, otherKey, 401);

  const queueQuery = `?chat_jid=${encodeURIComponent(sessionId)}`;
  await expectStatus(`/agent/queue-state${queueQuery}`, ownerKey, 200);
  await expectStatus(`/agent/queue-state${queueQuery}`, otherKey, 401);
  await expectStatus(`/agent/queue-steer${queueQuery}`, ownerKey, 200, {
    method: "POST",
    body: JSON.stringify({ row_id: 1 }),
  });
  await expectStatus(`/agent/queue-steer${queueQuery}`, otherKey, 401, {
    method: "POST",
    body: JSON.stringify({ row_id: 1 }),
  });
  await expectStatus(`/agent/queue-remove${queueQuery}`, ownerKey, 200, {
    method: "POST",
    body: JSON.stringify({ row_id: 1 }),
  });
  await expectStatus(`/agent/queue-remove${queueQuery}`, otherKey, 401, {
    method: "POST",
    body: JSON.stringify({ row_id: 1 }),
  });

  const workspaceQuery = `?chat_jid=${encodeURIComponent(sessionId)}`;
  await expectStatus(`/workspace/index-status${workspaceQuery}`, ownerKey, 200);
  await expectStatus(`/workspace/index-status${workspaceQuery}`, otherKey, 401);

  const upload = await expectStatus("/media/upload", ownerKey, 200, {
    method: "POST",
    body: (() => {
      const form = new FormData();
      form.set("file", new File(["owner media"], "owner.txt", { type: "text/plain" }));
      return form;
    })(),
  });
  mediaId = Number((await upload.json()).id);
  await expectStatus(`/media/${mediaId}/info`, ownerKey, 200);
  await expectStatus(`/media/${mediaId}/info`, otherKey, 404);

  await createScheduledTask({
    id: taskId,
    sessionId,
    prompt: "two-user isolation task",
    scheduleType: "once",
    scheduleValue: "2026-08-01T00:00:00Z",
  });
  await expectStatus(`/agent/scheduled-tasks?id=${encodeURIComponent(taskId)}`, ownerKey, 200);
  await expectStatus(`/agent/scheduled-tasks?id=${encodeURIComponent(taskId)}`, otherKey, 401);
  console.log("✅ owner can access session/messages/stream/queue/subagents/workspace/media/tasks; other user is denied");
  completed = true;
} finally {
  if (mediaId) await sql`DELETE FROM media WHERE id = ${mediaId}`;
  await sql`DELETE FROM scheduled_tasks WHERE id = ${taskId}`;
  await sql`DELETE FROM api_keys WHERE user_id IN (${ownerId}, ${otherId})`;
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
  await sql`DELETE FROM users WHERE id IN (${ownerId}, ${otherId})`;
  await sql.end();
}

if (completed) process.exit(0);
