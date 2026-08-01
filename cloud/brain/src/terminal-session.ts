type TerminalHandle = { pid: number };

export async function attachTerminal(options: {
  terminalPid: number | null | undefined;
  connect: (pid: number) => Promise<TerminalHandle>;
  create: () => Promise<TerminalHandle>;
  setTerminalPid: (pid: number) => Promise<void>;
  clearTerminalPid: () => Promise<void>;
}): Promise<TerminalHandle> {
  if (options.terminalPid) {
    try {
      const terminal = await options.connect(options.terminalPid);
      await options.setTerminalPid(terminal.pid);
      return terminal;
    } catch {
      await options.clearTerminalPid();
    }
  }

  const terminal = await options.create();
  await options.setTerminalPid(terminal.pid);
  return terminal;
}
