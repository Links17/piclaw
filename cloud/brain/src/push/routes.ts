import * as store from "@piclaw-cloud/store";
import { webNotificationPresenceService } from "./presence.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function resolveUserAgent(req: Request): string | null {
  const value = req.headers.get("user-agent");
  return value && value.trim() ? value.trim() : null;
}

function resolveDeviceId(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

export async function handleWebPushRoutes(
  req: Request,
  pathname: string,
  userId: string,
): Promise<Response | null> {
  if (req.method === "GET" && pathname === "/agent/push/vapid-public-key") {
    const keys = await store.ensureStoredVapidKeys();
    return json({ publicKey: keys.publicKey });
  }

  if (req.method === "POST" && pathname === "/agent/push/subscription") {
    try {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      const subscription = body && typeof body === "object" && body.subscription ? body.subscription : body;
      const stored = await store.upsertWebPushSubscription(subscription, {
        userId,
        userAgent: resolveUserAgent(req),
        deviceId: resolveDeviceId(body?.device_id ?? body?.deviceId),
      });
      return json({ ok: true, device_id: stored.deviceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid push subscription.";
      return json({ error: message }, 400);
    }
  }

  if (req.method === "DELETE" && pathname === "/agent/push/subscription") {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const subscription = body && typeof body === "object" && body.subscription ? body.subscription : body;
    const endpoint = typeof (subscription as Record<string, unknown> | null)?.endpoint === "string"
      ? String((subscription as Record<string, unknown>).endpoint).trim()
      : typeof body?.endpoint === "string"
        ? body.endpoint.trim()
        : "";
    if (!endpoint) return json({ error: "Missing push subscription endpoint." }, 400);
    const removed = await store.removeWebPushSubscription(endpoint, userId);
    return json({ ok: true, removed });
  }

  if (req.method === "POST" && pathname === "/agent/push/presence") {
    try {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return json({ error: "Invalid web notification presence payload." }, 400);
      }
      const payload = body as Record<string, unknown>;
      if (payload.active === false) {
        const removed = webNotificationPresenceService.remove(payload);
        return json({ ok: true, active: false, removed });
      }
      const stored = webNotificationPresenceService.upsert(payload, { userAgent: resolveUserAgent(req) });
      return json({
        ok: true,
        active: true,
        device_id: stored.deviceId,
        client_id: stored.clientId,
        chat_jid: stored.chatJid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid web notification presence payload.";
      return json({ error: message }, 400);
    }
  }

  return null;
}
