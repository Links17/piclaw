/**
 * Redis event bus — the volatile stream layer. Token deltas and turn status
 * flow through pub/sub on `session:{id}`; nothing here is data of record.
 */
import { Redis } from "ioredis";
import { config } from "./config.ts";

const publisher = new Redis(config.redisUrl);

export type SessionEvent =
  | { type: "delta"; text: string; replica: string }
  | { type: "message"; id: number; role: string; content: string; recovery?: boolean }
  | { type: "turn_started"; messageId: number; replica: string }
  | { type: "turn_done"; messageId: number; replica: string; dbRoundtrips: number; durationMs: number }
  | { type: "turn_failed"; messageId: number; error: string; replica: string }
  | { type: "followup_queued"; content: string }
  | { type: "followup_consumed"; content: string }
  | { type: "recovery"; messageId: number; action: "retried" | "cleared"; replica: string };

export function channelFor(sessionId: string): string {
  return `session:${sessionId}`;
}

export async function publish(sessionId: string, event: SessionEvent): Promise<void> {
  await publisher.publish(channelFor(sessionId), JSON.stringify(event));
}

/**
 * Subscribe to one session's channel with a dedicated connection
 * (one per SSE client is fine at PoC scale).
 */
export function subscribe(sessionId: string, onEvent: (event: SessionEvent) => void): () => void {
  const sub = new Redis(config.redisUrl);
  void sub.subscribe(channelFor(sessionId));
  sub.on("message", (_channel, payload) => {
    try {
      onEvent(JSON.parse(payload) as SessionEvent);
    } catch {
      // malformed payloads are dropped; the durable truth lives in PG
    }
  });
  return () => {
    sub.disconnect();
  };
}

export async function closePublisher(): Promise<void> {
  publisher.disconnect();
}
