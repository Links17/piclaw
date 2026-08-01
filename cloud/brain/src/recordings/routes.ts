/** HTTP routes for session recording lifecycle, export, and playback. */

import * as store from "@piclaw-cloud/store";
import { recordingPlaybackHtml } from "./playback-html.ts";
import {
  deleteSessionRecording,
  getActiveSessionRecording,
  getSessionRecording,
  listActiveSessionRecordings,
  listSessionRecordings,
  previewSessionRecordingRedaction,
  recordSessionFixtureNote,
  recordTimelineInteraction,
  startSessionRecording,
  stopSessionRecording,
} from "./service.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => ({}));
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function resolveIdFromPath(pathname: string): string {
  const prefix = "/agent/recordings/";
  if (!pathname.startsWith(prefix)) return "";
  return decodeURIComponent(pathname.slice(prefix.length).split("/")[0] || "").trim();
}

function safeDownloadName(value: string): string {
  return String(value || "recording").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "recording";
}

function attachmentResponse(body: string, filename: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${safeDownloadName(filename)}"`,
    },
  });
}

async function exportRecordingResponse(id: string, req: Request, userId: string): Promise<Response> {
  const recording = await getSessionRecording(id, userId);
  if (!recording) return json({ error: "Recording not found." }, 404);
  const format = (new URL(req.url).searchParams.get("format") || "json").toLowerCase();
  const stem = safeDownloadName(`${recording.meta.title || recording.meta.id}-${recording.meta.id}`);
  if (format === "jsonl") {
    const body = recording.events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    return attachmentResponse(body, `${stem}.jsonl`, "application/x-ndjson; charset=utf-8");
  }
  if (format === "html") {
    return attachmentResponse(recordingPlaybackHtml(recording), `${stem}.html`, "text/html; charset=utf-8");
  }
  return attachmentResponse(JSON.stringify(recording, null, 2), `${stem}.json`, "application/json; charset=utf-8");
}

export async function handleSessionRecordingRoutes(
  req: Request,
  pathname: string,
  userId: string,
  readTimeline: (chatJid: string, limit: number) => Promise<{ posts: any[] }> =
    async (chatJid, limit) => {
      const { getTimeline } = await import("../web-adapter.ts");
      return getTimeline(chatJid, limit);
    },
  getOwnedSession: typeof store.getSessionForUser = store.getSessionForUser,
): Promise<Response | null> {
  if (req.method === "GET" && pathname === "/recordings/playback") {
    return new Response(recordingPlaybackHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (!pathname.startsWith("/agent/recordings")) return null;

  if (req.method === "GET" && pathname === "/agent/recordings") {
    return json({
      ok: true,
      recordings: await listSessionRecordings(userId),
      active: await listActiveSessionRecordings(userId),
    });
  }

  if (req.method === "POST" && pathname === "/agent/recordings/redact-preview") {
    const body = await readJson(req);
    return json({
      ok: true,
      preview: previewSessionRecordingRedaction(body.payload, { mode: body.mode, redaction: body.redaction }),
    });
  }

  if (req.method === "POST" && pathname === "/agent/recordings/start") {
    const body = await readJson(req);
    const chatJid = body.chat_jid ?? body.chatJid;
    const sessionId = typeof chatJid === "string" ? chatJid.trim() : "";
    if (!sessionId || !(await getOwnedSession(sessionId, userId))) {
      return json({ error: "recording session access denied" }, 401);
    }
    const meta = await startSessionRecording({
      chatJid: sessionId,
      title: body.title,
      mode: body.mode,
      redaction: body.redaction,
      userId,
    });
    const includeSnapshot = body.include_timeline_snapshot === true || body.includeTimelineSnapshot === true;
    if (includeSnapshot && meta.eventCount <= 1) {
      const limit = Math.min(250, Math.max(1, Number(body.timeline_snapshot_limit ?? body.timelineSnapshotLimit ?? 50) || 50));
      const snapshot = await readTimeline(sessionId, limit);
      await recordSessionFixtureNote(meta.chatJid, { type: "timeline_snapshot", count: snapshot.posts.length, limit });
      for (const interaction of snapshot.posts) {
        await recordTimelineInteraction(interaction);
      }
    }
    return json({ ok: true, recording: (await getActiveSessionRecording(meta.chatJid, userId)) || meta }, 201);
  }

  if (req.method === "POST" && pathname === "/agent/recordings/stop") {
    const body = await readJson(req);
    const key = typeof body.id === "string" ? body.id : (typeof body.chat_jid === "string" ? body.chat_jid : body.chatJid);
    if (typeof key !== "string" || !key.trim()) return json({ error: "Provide id or chat_jid." }, 400);
    const meta = await stopSessionRecording(key, userId);
    if (!meta) return json({ error: "Recording not active." }, 404);
    return json({ ok: true, recording: meta });
  }

  if (req.method === "GET" && pathname === "/agent/recordings/active") {
    const chatJid = new URL(req.url).searchParams.get("chat_jid") || "web:default";
    return json({ ok: true, recording: await getActiveSessionRecording(chatJid, userId) });
  }

  const id = resolveIdFromPath(pathname);
  if (!id) return json({ error: "Not found" }, 404);

  if (req.method === "GET" && pathname.endsWith("/export")) {
    return exportRecordingResponse(id, req, userId);
  }

  if (req.method === "GET") {
    const recording = await getSessionRecording(id, userId);
    if (!recording) return json({ error: "Recording not found." }, 404);
    return json(recording);
  }

  if (req.method === "DELETE") {
    return json({ ok: true, deleted: await deleteSessionRecording(id, userId) });
  }

  return json({ error: "Not found" }, 404);
}
