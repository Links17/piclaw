const activeToolsBySession = new Map<string, Set<string>>();

export function getActiveToolNames(sessionId: string): Set<string> {
  return new Set(activeToolsBySession.get(sessionId) ?? []);
}

export function activateToolNames(
  sessionId: string,
  requestedNames: readonly string[],
  availableNames: ReadonlySet<string>,
): { activated: string[]; unknown: string[]; active: string[] } {
  const active = activeToolsBySession.get(sessionId) ?? new Set<string>();
  const activated: string[] = [];
  const unknown: string[] = [];

  for (const name of requestedNames) {
    if (!availableNames.has(name)) {
      unknown.push(name);
      continue;
    }
    if (!active.has(name)) {
      active.add(name);
      activated.push(name);
    }
  }

  activeToolsBySession.set(sessionId, active);
  return { activated, unknown, active: [...active].sort() };
}

export function resetActiveToolNames(sessionId: string): void {
  activeToolsBySession.delete(sessionId);
}
