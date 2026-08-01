export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

export function decodeTerminalClientMessage(raw: string): TerminalClientMessage | null {
  try {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (message.type === "input" && typeof message.data === "string") {
      return { type: "input", data: message.data };
    }
    if (
      message.type === "resize"
      && Number.isInteger(message.cols)
      && Number.isInteger(message.rows)
      && (message.cols as number) > 0
      && (message.rows as number) > 0
    ) {
      return { type: "resize", cols: message.cols as number, rows: message.rows as number };
    }
    if (message.type === "ping") return { type: "ping" };
  } catch {
    return { type: "input", data: raw };
  }
  return null;
}

export async function forwardTerminalClientMessage(
  raw: string,
  sendInput: (data: string) => Promise<void>,
): Promise<boolean> {
  const message = decodeTerminalClientMessage(raw);
  if (message?.type !== "input") return false;
  await sendInput(message.data);
  return true;
}
