/**
 * SSE event vocabulary — canonical contract between brain and runtime/web.
 * PoC internal names (turn-loop) map to these via brain/events/publish.ts.
 */
export type AgentStatus = "idle" | "thinking" | "streaming" | "tool" | "error";

/** Events the Web UI SSEClient already handles (runtime/web/src/ui/app-sse-events.ts). */
export type WebSseEvent =
  | { type: "connected"; chatJid: string }
  | { type: "agent_status"; status: AgentStatus; detail?: string }
  | { type: "agent_draft_delta"; delta: string }
  | { type: "agent_draft"; text: string }
  | { type: "agent_thought_delta"; delta: string }
  | { type: "agent_response"; messageId: string; content: string; recovery?: boolean }
  | { type: "agent_followup_queued"; content: string }
  | { type: "agent_followup_consumed"; content: string }
  | { type: "agent_steer_queued"; content: string }
  | { type: "model_changed"; model: string }
  | { type: "workspace_update"; path: string };

/** Internal brain bus events (Redis pub/sub); translated before SSE. */
export type InternalSessionEvent =
  | { type: "delta"; text: string; replica: string }
  | { type: "message"; id: number; role: string; content: string; recovery?: boolean }
  | { type: "turn_started"; messageId: number; replica: string }
  | { type: "turn_done"; messageId: number; replica: string; dbRoundtrips: number; durationMs: number }
  | { type: "turn_failed"; messageId: number; error: string; replica: string }
  | { type: "followup_queued"; content: string }
  | { type: "followup_consumed"; content: string }
  | { type: "recovery"; messageId: number; action: "retried" | "cleared"; replica: string };

export function mapInternalToWeb(
  sessionId: string,
  event: InternalSessionEvent,
): WebSseEvent | { type: "heartbeat" } | null {
  switch (event.type) {
    case "delta":
      return { type: "agent_draft_delta", delta: event.text };
    case "message":
      if (event.role !== "assistant") return null;
      return {
        type: "agent_response",
        messageId: String(event.id),
        content: event.content,
        recovery: event.recovery,
      };
    case "turn_started":
      return { type: "agent_status", status: "streaming" };
    case "turn_done":
      return { type: "agent_status", status: "idle" };
    case "turn_failed":
      return { type: "agent_status", status: "error", detail: event.error };
    case "followup_queued":
      return { type: "agent_followup_queued", content: event.content };
    case "followup_consumed":
      return { type: "agent_followup_consumed", content: event.content };
    default:
      return null;
  }
}

export const DEFAULT_USER_ID = "default-user";
