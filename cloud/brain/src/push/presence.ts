/**
 * In-memory browser presence for Web Push routing (suppress when tab is visible).
 */

export const DEFAULT_WEB_NOTIFICATION_PRESENCE_TTL_MS = 120_000;

export interface WebNotificationPresenceRecord {
  deviceId: string;
  clientId: string;
  chatJid: string;
  visibilityState: "visible" | "hidden";
  hasFocus: boolean;
  updatedAtMs: number;
  userAgent: string | null;
}

function normalizeTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeWebNotificationPresence(
  value: unknown,
  options: { nowMs?: number; userAgent?: string | null } = {},
): WebNotificationPresenceRecord | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const deviceId = normalizeTrimmed(input.device_id ?? input.deviceId);
  const clientId = normalizeTrimmed(input.client_id ?? input.clientId);
  const chatJid = normalizeTrimmed(input.chat_jid ?? input.chatJid);
  if (!deviceId || !clientId || !chatJid) return null;
  const rawVisibility = normalizeTrimmed(input.visibility_state ?? input.visibilityState).toLowerCase();
  return {
    deviceId,
    clientId,
    chatJid,
    visibilityState: rawVisibility === "hidden" ? "hidden" : "visible",
    hasFocus: Boolean(input.has_focus ?? input.hasFocus),
    updatedAtMs: options.nowMs ?? Date.now(),
    userAgent: typeof options.userAgent === "string" && options.userAgent.trim() ? options.userAgent.trim() : null,
  };
}

class WebNotificationPresenceService {
  private readonly records = new Map<string, WebNotificationPresenceRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_WEB_NOTIFICATION_PRESENCE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private key(deviceId: string, clientId: string): string {
    return `${deviceId}::${clientId}`;
  }

  private isLive(record: WebNotificationPresenceRecord, nowMs: number): boolean {
    return nowMs - record.updatedAtMs <= this.ttlMs;
  }

  private prune(nowMs: number): void {
    for (const [key, record] of this.records.entries()) {
      if (!this.isLive(record, nowMs)) this.records.delete(key);
    }
  }

  upsert(value: unknown, options: { userAgent?: string | null } = {}): WebNotificationPresenceRecord {
    const nowMs = Date.now();
    const normalized = normalizeWebNotificationPresence(value, { nowMs, userAgent: options.userAgent });
    if (!normalized) throw new Error("Invalid web notification presence payload.");
    this.prune(nowMs);
    this.records.set(this.key(normalized.deviceId, normalized.clientId), normalized);
    return normalized;
  }

  remove(value: { device_id?: unknown; deviceId?: unknown; client_id?: unknown; clientId?: unknown }): boolean {
    const deviceId = normalizeTrimmed(value?.device_id ?? value?.deviceId);
    const clientId = normalizeTrimmed(value?.client_id ?? value?.clientId);
    if (!deviceId || !clientId) return false;
    return this.records.delete(this.key(deviceId, clientId));
  }

  shouldSendWebPush(deviceId: string | null | undefined, chatJid: string | null | undefined): boolean {
    const normalizedDeviceId = normalizeTrimmed(deviceId);
    const normalizedChatJid = normalizeTrimmed(chatJid);
    if (!normalizedDeviceId || !normalizedChatJid) return true;
    const nowMs = Date.now();
    this.prune(nowMs);
    const clients = Array.from(this.records.values()).filter(
      (record) => record.deviceId === normalizedDeviceId
        && record.chatJid === normalizedChatJid
        && this.isLive(record, nowMs),
    );
    if (clients.length === 0) return true;
    return !clients.some((record) => record.visibilityState === "visible");
  }
}

export const webNotificationPresenceService = new WebNotificationPresenceService();
