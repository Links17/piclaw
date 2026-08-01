import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { sql } from "./db.ts";

export interface StoredWebPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { auth: string; p256dh: string };
  deviceId: string | null;
  userAgent: string | null;
}

export interface StoredVapidKeys {
  publicKey: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function encodeBase64Url(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function createVapidKeys(): StoredVapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  const publicJwk = createPublicKey(publicKey).export({ format: "jwk" }) as JsonWebKey;
  const x = typeof publicJwk.x === "string" ? publicJwk.x : "";
  const y = typeof publicJwk.y === "string" ? publicJwk.y : "";
  if (!x || !y) throw new Error("Generated VAPID key is missing JWK coordinates.");
  const publicPoint = Buffer.concat([Buffer.from([0x04]), decodeBase64Url(x), decodeBase64Url(y)]);
  return { publicKey: encodeBase64Url(publicPoint), publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export async function ensureStoredVapidKeys(): Promise<StoredVapidKeys> {
  const rows = await sql`SELECT public_key, public_key_pem, private_key_pem FROM web_push_vapid_keys WHERE id = 1`;
  const row = rows[0];
  if (row) {
    return {
      publicKey: String(row.public_key),
      publicKeyPem: String(row.public_key_pem),
      privateKeyPem: String(row.private_key_pem),
    };
  }
  const created = createVapidKeys();
  await sql`
    INSERT INTO web_push_vapid_keys (id, public_key, public_key_pem, private_key_pem)
    VALUES (1, ${created.publicKey}, ${created.publicKeyPem}, ${created.privateKeyPem})`;
  return created;
}

export function normalizeWebPushSubscription(
  value: unknown,
  options: { userAgent?: string | null; deviceId?: string | null } = {},
): StoredWebPushSubscription | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
  const p256dh = typeof (input.keys as Record<string, unknown> | undefined)?.p256dh === "string"
    ? String((input.keys as Record<string, unknown>).p256dh).trim()
    : "";
  const auth = typeof (input.keys as Record<string, unknown> | undefined)?.auth === "string"
    ? String((input.keys as Record<string, unknown>).auth).trim()
    : "";
  if (!endpoint.startsWith("https://") || !p256dh || !auth) return null;
  const rawExpiration = input.expirationTime;
  const expirationTime = rawExpiration == null ? null : Number(rawExpiration);
  return {
    endpoint,
    expirationTime: Number.isFinite(expirationTime) ? expirationTime : null,
    keys: { auth, p256dh },
    deviceId: options.deviceId ?? (typeof input.deviceId === "string" ? input.deviceId.trim() || null : null),
    userAgent: options.userAgent ?? null,
  };
}

function requireUserId(userId: string | undefined): string {
  const normalized = userId?.trim() ?? "";
  if (!normalized) throw new Error("userId is required for web push ownership.");
  return normalized;
}

export async function listWebPushSubscriptions(userId: string): Promise<StoredWebPushSubscription[]> {
  userId = requireUserId(userId);
  const rows = await sql`
    SELECT endpoint, expiration_time, p256dh, auth, device_id, user_agent
    FROM web_push_subscriptions
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC`;
  return rows.map((row: Record<string, unknown>) => ({
    endpoint: String(row.endpoint),
    expirationTime: row.expiration_time == null ? null : Number(row.expiration_time),
    keys: { auth: String(row.auth), p256dh: String(row.p256dh) },
    deviceId: row.device_id != null ? String(row.device_id) : null,
    userAgent: row.user_agent != null ? String(row.user_agent) : null,
  }));
}

export async function upsertWebPushSubscription(
  value: unknown,
  options: { userId: string; userAgent?: string | null; deviceId?: string | null },
): Promise<StoredWebPushSubscription> {
  const normalized = normalizeWebPushSubscription(value, options);
  if (!normalized) throw new Error("Invalid push subscription.");
  const userId = requireUserId(options.userId);
  const rows = await sql`
    INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh, auth, expiration_time, device_id, user_agent)
    VALUES (
      ${userId},
      ${normalized.endpoint},
      ${normalized.keys.p256dh},
      ${normalized.keys.auth},
      ${normalized.expirationTime},
      ${normalized.deviceId},
      ${normalized.userAgent}
    )
    ON CONFLICT (endpoint) DO UPDATE SET
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      expiration_time = EXCLUDED.expiration_time,
      device_id = COALESCE(EXCLUDED.device_id, web_push_subscriptions.device_id),
      user_agent = COALESCE(EXCLUDED.user_agent, web_push_subscriptions.user_agent),
      updated_at = now()
    WHERE web_push_subscriptions.user_id = EXCLUDED.user_id
    RETURNING user_id`;
  if (!rows[0]) throw new Error("Push subscription endpoint is owned by another user.");
  return normalized;
}

export async function removeWebPushSubscription(endpoint: string, userId: string): Promise<boolean> {
  const normalized = endpoint.trim();
  if (!normalized) return false;
  userId = requireUserId(userId);
  const rows = await sql`
    DELETE FROM web_push_subscriptions
    WHERE endpoint = ${normalized} AND user_id = ${userId}
    RETURNING id`;
  return rows.length > 0;
}
