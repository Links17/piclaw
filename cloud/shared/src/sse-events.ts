/**
 * SSE event vocabulary — canonical contract between brain and runtime/web.
 * PoC internal names (turn-loop) map to these via brain/events/publish.ts.
 */
export type AgentStatus = "idle" | "thinking" | "streaming" | "tool" | "error";

export interface SseScope {
  chatJid: string;
  turnId?: string | null;
}

export interface SseEnvelope {
  event: string;
  data: Record<string, unknown>;
}

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
  | { type: "recovery"; messageId: number; action: "retried" | "cleared"; replica: string }
  | { type: "tool_start"; name: string; toolCallId: string; replica: string }
  | { type: "tool_result"; name: string; toolCallId: string; isError: boolean; replica: string }
  | { type: "subagent_started"; runId: string; agentType: string; task: string; replica: string }
  | { type: "subagent_delta"; runId: string; text: string; replica: string }
  | { type: "subagent_tool_start"; runId: string; name: string; toolCallId: string; replica: string }
  | { type: "subagent_tool_result"; runId: string; name: string; toolCallId: string; isError: boolean; replica: string }
  | { type: "subagent_done"; runId: string; status: string; summary: string; artifacts: string[]; replica: string };

function scoped(scope: SseScope, data: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...data, chat_jid: scope.chatJid };
  if (scope.turnId) payload.turn_id = scope.turnId;
  return payload;
}

function agentStatusEnvelope(
  scope: SseScope,
  statusType: string,
  title: string,
  extra: Record<string, unknown> = {},
): SseEnvelope {
  return {
    event: "agent_status",
    data: scoped(scope, { type: statusType, title, ...extra }),
  };
}

/** Map internal bus events to classic Web UI SSE envelopes. */
export function mapInternalToSse(scope: SseScope, event: InternalSessionEvent): SseEnvelope | null {
  switch (event.type) {
    case "delta":
      return {
        event: "agent_draft_delta",
        data: scoped(scope, { delta: event.text }),
      };
    case "message":
      return null;
    case "turn_started":
      return agentStatusEnvelope(
        { ...scope, turnId: String(event.messageId) },
        "thinking",
        "Thinking...",
      );
    case "turn_done":
      return agentStatusEnvelope(scope, "done", "Idle");
    case "turn_failed":
      return agentStatusEnvelope(scope, "error", event.error, { detail: event.error });
    case "followup_queued":
      return {
        event: "agent_followup_queued",
        data: scoped(scope, { content: event.content }),
      };
    case "followup_consumed":
      return {
        event: "agent_followup_consumed",
        data: scoped(scope, { content: event.content }),
      };
    case "tool_start":
      return agentStatusEnvelope(scope, "tool", event.name, { detail: event.name });
    case "tool_result":
      return agentStatusEnvelope(scope, "streaming", "Working...");
    case "subagent_started":
      return agentStatusEnvelope(scope, "tool", `coding:${event.runId}`, {
        detail: `coding:${event.runId}`,
      });
    case "subagent_done":
      return agentStatusEnvelope(scope, "streaming", "Working...");
    default:
      return null;
  }
}

/** @deprecated Use mapInternalToSse — kept for tests migrating gradually. */
export function mapInternalToWeb(
  _sessionId: string,
  event: InternalSessionEvent,
  scope?: SseScope,
): WebSseEvent | { type: "heartbeat" } | null {
  const resolvedScope = scope ?? { chatJid: _sessionId, turnId: null };
  const envelope = mapInternalToSse(resolvedScope, event);
  if (!envelope) return null;
  if (envelope.event === "agent_draft_delta") {
    return { type: "agent_draft_delta", delta: String(envelope.data.delta ?? "") };
  }
  if (envelope.event === "agent_status") {
    const statusType = String(envelope.data.type ?? "streaming");
    const detail = typeof envelope.data.detail === "string" ? envelope.data.detail : undefined;
    if (statusType === "thinking") return { type: "agent_status", status: "thinking", detail };
    if (statusType === "tool") return { type: "agent_status", status: "tool", detail };
    if (statusType === "error") return { type: "agent_status", status: "error", detail };
    if (statusType === "done") return { type: "agent_status", status: "idle" };
    return { type: "agent_status", status: "streaming", detail };
  }
  if (envelope.event === "agent_followup_queued") {
    return { type: "agent_followup_queued", content: String(envelope.data.content ?? "") };
  }
  if (envelope.event === "agent_followup_consumed") {
    return { type: "agent_followup_consumed", content: String(envelope.data.content ?? "") };
  }
  return null;
}

export const DEFAULT_USER_ID = "default-user";
