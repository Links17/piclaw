/**
 * Redis pub/sub bus — volatile stream layer. SSE bridges map internal → Web vocabulary.
 */
import { Redis } from "ioredis";
import type { InternalSessionEvent } from "@piclaw-cloud/shared/sse-events";
import { config } from "./config.ts";

export type SessionEvent = InternalSessionEvent;

const publisher = new Redis(config.redisUrl);

export function channelFor(sessionId: string): string {
  return `session:${sessionId}`;
}

export async function publish(sessionId: string, event: SessionEvent): Promise<void> {
  await publisher.publish(channelFor(sessionId), JSON.stringify(event));
}

export function subscribe(sessionId: string, onEvent: (event: SessionEvent) => void): () => void {
  const sub = new Redis(config.redisUrl);
  void sub.subscribe(channelFor(sessionId));
  sub.on("message", (_channel, payload) => {
    try {
      onEvent(JSON.parse(payload) as SessionEvent);
    } catch {
      // malformed payloads dropped; PG is source of truth
    }
  });
  return () => {
    sub.disconnect();
  };
}

export async function closePublisher(): Promise<void> {
  publisher.disconnect();
}
