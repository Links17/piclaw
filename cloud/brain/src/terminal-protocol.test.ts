import { describe, expect, test } from "bun:test";
import { decodeTerminalClientMessage, forwardTerminalClientMessage } from "./terminal-protocol.ts";

describe("terminal WebSocket client protocol", () => {
  test("forwards a structured input message as shell bytes", () => {
    expect(decodeTerminalClientMessage(JSON.stringify({
      type: "input",
      data: "echo TERMINAL_PROTOCOL_OK\n",
    }))).toEqual({
      type: "input",
      data: "echo TERMINAL_PROTOCOL_OK\n",
    });
  });

  test("keeps legacy raw shell input compatible", () => {
    expect(decodeTerminalClientMessage("echo RAW_TERMINAL_OK\n")).toEqual({
      type: "input",
      data: "echo RAW_TERMINAL_OK\n",
    });
  });

  test("does not send resize control frames to the shell", async () => {
    const sendInput = async (_data: string) => {
      throw new Error("resize must not be treated as shell input");
    };

    await expect(forwardTerminalClientMessage(
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
      sendInput,
    )).resolves.toBe(false);
  });
});
