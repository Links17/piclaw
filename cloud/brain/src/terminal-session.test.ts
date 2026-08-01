import { describe, expect, test } from "bun:test";
import { attachTerminal } from "./terminal-session.ts";

describe("terminal PTY attachment", () => {
  test("reuses the stored PID after a WebSocket reconnect", async () => {
    const connect = async (pid: number) => ({ pid });
    const create = async () => ({ pid: 901 });
    const setPid: number[] = [];

    const terminal = await attachTerminal({
      terminalPid: 812,
      connect,
      create,
      setTerminalPid: async (pid) => { setPid.push(pid); },
      clearTerminalPid: async () => { throw new Error("must not clear a live PID"); },
    });

    expect(terminal.pid).toBe(812);
    expect(setPid).toEqual([812]);
  });

  test("clears only a stale PID before creating a replacement terminal", async () => {
    const cleared: string[] = [];
    const setPid: number[] = [];

    const terminal = await attachTerminal({
      terminalPid: 812,
      connect: async () => { throw new Error("PTY no longer exists"); },
      create: async () => ({ pid: 901 }),
      setTerminalPid: async (pid) => { setPid.push(pid); },
      clearTerminalPid: async () => { cleared.push("terminal"); },
    });

    expect(terminal.pid).toBe(901);
    expect(cleared).toEqual(["terminal"]);
    expect(setPid).toEqual([901]);
  });
});
