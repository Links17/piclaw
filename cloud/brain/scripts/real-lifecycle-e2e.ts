/**
 * Real CubeSandbox volume-only lifecycle and storage-boundary acceptance.
 */
import { sql } from "@piclaw-cloud/store/db";
import { connectSandbox } from "../src/sandbox/client.ts";
import { cleanupSessionResources, ensureSandbox, pauseSessionSandbox } from "../src/sandbox/session.ts";
import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { ensureE2eSession } from "./e2e-session.ts";

const BASE = process.env.CLOUD_E2E_BASE || "http://127.0.0.1:17804";
const run = new RealAcceptance();
const CHAT = run.session("lifecycle");
const MARKER = `VOLUME_ONLY_${Date.now()}`;

async function waitFor(predicate: () => Promise<boolean>, name: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`timeout waiting for ${name}`);
}

console.log(`Real lifecycle/storage E2E (${CHAT})`);
try {
  await run.preflight(BASE, { sandbox: true });
  await ensureE2eSession(BASE, CHAT, "real lifecycle acceptance");

  const first = await ensureSandbox(CHAT);
  const initial = await fetch(`${BASE}/sessions/${encodeURIComponent(CHAT)}`).then((res) => res.json()) as {
    session: { sandbox_id: string | null; workspace_volume_id: string | null };
  };
  run.check(initial.session.sandbox_id === first.sandboxId, "session binds created sandbox");
  run.check(Boolean(initial.session.workspace_volume_id), "session persists workspace volume id");
  run.addResource("sandboxes", first.sandboxId);
  run.addResource("volumes", initial.session.workspace_volume_id!);

  const markerPath = "/workspace/real-volume-marker.txt";
  await first.commands.run(`printf '%s\\n' '${MARKER}' > ${markerPath}`);
  run.check(true, "writes marker to CubeSandbox workspace volume");

  run.check(await pauseSessionSandbox(CHAT), "pauses the real sandbox");
  const paused = await fetch(`${BASE}/sessions/${encodeURIComponent(CHAT)}`).then((res) => res.json()) as {
    session: { workspace_volume_id: string | null; sandbox_paused_at: string | null };
  };
  run.check(paused.session.workspace_volume_id === initial.session.workspace_volume_id, "pause preserves the same volume binding");
  run.check(Boolean(paused.session.sandbox_paused_at), "pause persists paused marker");

  const resumed = await ensureSandbox(CHAT);
  if (resumed.sandboxId !== first.sandboxId) run.addResource("sandboxes", resumed.sandboxId);
  await waitFor(async () => {
    try {
      const output = await resumed.commands.run(`cat ${markerPath}`);
      return output.stdout.includes(MARKER);
    } catch {
      return false;
    }
  }, "same-volume marker after resume/recreate");
  run.check(true, "workspace file survives entirely through CubeSandbox volume");

  const upload = await fetch(`${BASE}/media/upload`, {
    method: "POST",
    body: (() => {
      const form = new FormData();
      form.set("file", new File(["real-media-binary"], "real-media.txt", { type: "text/plain" }));
      return form;
    })(),
  });
  const media = await upload.json() as { id?: number };
  run.check(upload.ok && Number.isInteger(media.id), "uploads media through real object storage route");
  run.addResource("media", String(media.id));
  const mediaRow = await sql`
    SELECT object_key, object_size
    FROM media WHERE id = ${media.id!}`;
  run.check(Boolean(mediaRow[0]?.object_key), "media stores external object key");
  const binaryColumns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'media' AND column_name IN ('data', 'thumbnail')`;
  run.check(binaryColumns.length === 0, "media table contains no binary columns");

  const beforeDelete = await fetch(`${BASE}/sessions/${encodeURIComponent(CHAT)}`).then((res) => res.json()) as {
    session: { sandbox_id: string | null; workspace_volume_id: string | null };
  };
  await cleanupSessionResources({ id: CHAT, ...beforeDelete.session });
  run.check(true, "deletes remote sandbox and volume before database deletion");
  await sql`DELETE FROM session_cursors WHERE session_id = ${CHAT}`;
  await sql`DELETE FROM sessions WHERE id = ${CHAT}`;
  const absent = await fetch(`${BASE}/sessions/${encodeURIComponent(CHAT)}`);
  run.check(absent.status === 404 || absent.status === 500, "session record removed after resource cleanup");
  run.report.resources.sessions = run.report.resources.sessions.filter((id) => id !== CHAT);
  run.report.resources.sandboxes = [];
  run.report.resources.volumes = [];
} finally {
  await run.cleanup();
  const report = await run.writeReport();
  console.log(`report: ${report}`);
}
