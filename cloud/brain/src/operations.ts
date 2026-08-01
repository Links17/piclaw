let draining = false;
const activeOperations = new Map<string, { kind: string; startedAt: number }>();

export interface OperationHandle {
  id: string;
  kind: string;
  startedAt: number;
  finish(): void;
}

export function beginDrain(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

export function drainingResponse(retryAfterSeconds = 5): Response {
  return Response.json(
    { error: "replica_draining", retry_after_seconds: retryAfterSeconds },
    {
      status: 503,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

export function getActiveRequestCount(): number {
  return activeOperations.size;
}

export function getActiveOperationCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const operation of activeOperations.values()) {
    counts[operation.kind] = (counts[operation.kind] ?? 0) + 1;
  }
  return counts;
}

export function getActiveOperationAgesByKind(now = Date.now()): Record<string, { count: number; oldestMs: number }> {
  const ages: Record<string, { count: number; oldestMs: number }> = {};
  for (const operation of activeOperations.values()) {
    const ageMs = Math.max(0, now - operation.startedAt);
    const current = ages[operation.kind] ?? { count: 0, oldestMs: 0 };
    ages[operation.kind] = {
      count: current.count + 1,
      oldestMs: Math.max(current.oldestMs, ageMs),
    };
  }
  return ages;
}

export function beginOperation(kind: string): OperationHandle {
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  activeOperations.set(id, { kind, startedAt });
  let finished = false;
  return {
    id,
    kind,
    startedAt,
    finish() {
      if (finished) return;
      finished = true;
      activeOperations.delete(id);
    },
  };
}

export function beginOperationIfAccepting(kind: string):
  | { accepted: true; operation: OperationHandle }
  | { accepted: false } {
  if (draining) return { accepted: false };
  return { accepted: true, operation: beginOperation(kind) };
}

export async function trackActiveRequest<T>(
  fn: () => Promise<T>,
  kind = "request",
): Promise<T> {
  const operation = beginOperation(kind);
  try {
    return await fn();
  } finally {
    operation.finish();
  }
}

export async function waitForDrain(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (activeOperations.size > 0 && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  return activeOperations.size === 0;
}

export function resetOperationsForTest(): void {
  draining = false;
  activeOperations.clear();
}
