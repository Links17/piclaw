import { createPrivateKey } from "node:crypto";
import * as store from "@piclaw-cloud/store";
import type { StoredVapidKeys } from "@piclaw-cloud/store";
import { webNotificationPresenceService } from "./presence.ts";

const DEFAULT_VAPID_SUBJECT = process.env.CLOUD_WEB_PUSH_VAPID_SUBJECT?.trim() || "mailto:notifications@localhost.invalid";

export interface WebPushNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

async function loadGenerateRequestDetails() {
  const mod = await import("web-push");
  const api = (mod as Record<string, unknown>).default && typeof (mod as Record<string, unknown>).default === "object"
    ? (mod as Record<string, unknown>).default as Record<string, unknown>
    : mod as Record<string, unknown>;
  const generateRequestDetails = api.generateRequestDetails;
  if (typeof generateRequestDetails !== "function") {
    throw new Error("web-push generateRequestDetails is unavailable.");
  }
  return generateRequestDetails.bind(api);
}

function vapidDetails(keys: store.StoredVapidKeys) {
  const privateJwk = createPrivateKey(keys.privateKeyPem).export({ format: "jwk" }) as JsonWebKey;
  const privateKey = typeof privateJwk.d === "string" ? privateJwk.d : "";
  if (!privateKey) throw new Error("Stored VAPID key is missing the private key scalar.");
  return { subject: DEFAULT_VAPID_SUBJECT, publicKey: keys.publicKey, privateKey };
}

export async function sendAgentReplyWebPush(options: {
  chatJid: string;
  body: string;
  userId: string;
}): Promise<void> {
  const subscriptions = await store.listWebPushSubscriptions(options.userId);
  if (subscriptions.length === 0) return;

  let vapidKeys: StoredVapidKeys;
  let generateRequestDetails: Awaited<ReturnType<typeof loadGenerateRequestDetails>>;
  try {
    vapidKeys = await store.ensureStoredVapidKeys();
    generateRequestDetails = await loadGenerateRequestDetails();
  } catch (error) {
    console.warn("[push] setup failed:", error instanceof Error ? error.message : error);
    return;
  }

  const payload = JSON.stringify({
    title: "PiClaw reply",
    body: options.body.replace(/\s+/g, " ").slice(0, 200) || "You have a new reply.",
    url: `/?chat_jid=${encodeURIComponent(options.chatJid)}`,
    tag: `piclaw:reply:${encodeURIComponent(options.chatJid)}`,
    sourceLabel: "Web Push",
  } satisfies WebPushNotificationPayload & { sourceLabel: string });

  const requestOptions = {
    TTL: 60,
    urgency: "normal" as const,
    vapidDetails: vapidDetails(vapidKeys),
  };

  for (const subscription of subscriptions) {
    if (!webNotificationPresenceService.shouldSendWebPush(subscription.deviceId, options.chatJid)) {
      continue;
    }
    try {
      const requestDetails = generateRequestDetails(subscription, payload, requestOptions);
      const response = await fetch(String(requestDetails.endpoint), {
        method: requestDetails.method || "POST",
        headers: Object.fromEntries(
          Object.entries(requestDetails.headers || {})
            .filter(([key]) => key.toLowerCase() !== "content-length")
            .map(([key, value]) => [key, String(value)]),
        ),
        body: requestDetails.body ?? undefined,
      });
      if (response.status === 404 || response.status === 410) {
        await store.removeWebPushSubscription(subscription.endpoint, options.userId);
      }
    } catch (error) {
      console.warn("[push] delivery failed:", error instanceof Error ? error.message : error);
    }
  }
}
