import * as store from "@piclaw-cloud/store";
import { chatJidToSessionId, ensureChatSession } from "../web-adapter.ts";

interface SessionTreeNode {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  label: string | null;
  active: boolean;
  preview: string;
  childCount: number;
  role?: string;
  toolName?: string;
  toolInput?: string;
  detail?: string;
  contentLength?: number;
  previewText?: string;
}

function previewText(content: string, max = 240): string {
  const trimmed = content.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function toolInputText(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return String(args ?? "");
  }
}

export async function getSessionTreeForChat(chatJid: string) {
  await ensureChatSession(chatJid);
  const sessionId = chatJidToSessionId(chatJid);
  const rows = await store.listMessages(sessionId, 500);
  const leafId = rows.length > 0 ? String(rows[rows.length - 1]!.id) : null;
  const nodes: SessionTreeNode[] = [];
  let parentId: string | null = null;

  for (const row of rows) {
    const id = String(row.id);
    const timestamp = row.created_at;
    if (row.role === "user") {
      nodes.push({
        id,
        parentId,
        type: "message",
        timestamp,
        label: null,
        active: id === leafId,
        preview: previewText(row.content),
        previewText: previewText(row.content),
        childCount: 0,
        role: "user",
      });
      parentId = id;
      continue;
    }

    if (row.role === "assistant") {
      const blocks = row.content_blocks as { tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown }> } | null;
      const toolCalls = Array.isArray(blocks?.tool_calls) ? blocks!.tool_calls! : [];
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const callId = `${id}:${call.id ?? call.name ?? "tool"}`;
          nodes.push({
            id: callId,
            parentId,
            type: "message",
            timestamp,
            label: null,
            active: callId === leafId,
            preview: call.name ? `[tool ${call.name}]` : "[tool]",
            childCount: 0,
            role: "assistant",
            toolName: call.name,
            toolInput: toolInputText(call.arguments),
          });
          parentId = callId;
        }
        continue;
      }
      nodes.push({
        id,
        parentId,
        type: "message",
        timestamp,
        label: null,
        active: id === leafId,
        preview: previewText(row.content),
        previewText: previewText(row.content),
        childCount: 0,
        role: "assistant",
      });
      parentId = id;
      continue;
    }

    if (row.role === "tool") {
      const blocks = row.content_blocks as { tool_call_id?: string; tool_name?: string } | null;
      nodes.push({
        id,
        parentId,
        type: "message",
        timestamp,
        label: null,
        active: id === leafId,
        preview: previewText(row.content, 120),
        childCount: 0,
        role: "toolResult",
        toolName: blocks?.tool_name ?? "tool",
        detail: previewText(row.content, 500),
        contentLength: row.content.length,
      });
      parentId = id;
    }
  }

  return { leafId, nodes, flat: true as const, total: nodes.length };
}
