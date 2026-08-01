import { describe, expect, test } from "bun:test";
import { REAL_E2E_PREFIX, RealAcceptance } from "./real-acceptance.ts";

describe("RealAcceptance", () => {
  test("registers unique prefixed resources for isolated cleanup", () => {
    const run = new RealAcceptance();
    const session = run.session("agent-core");
    run.addResource("volumes", "volume-1");
    run.addResource("sandboxes", "sandbox-1");
    run.addResource("usageUsers", "user-1");
    run.trackProcess("replica-a", async () => {});

    expect(run.id.startsWith(`${REAL_E2E_PREFIX}-`)).toBe(true);
    expect(session).toBe(`${run.id}-agent-core`);
    expect(run.report.resources).toMatchObject({
      sessions: [session],
      volumes: ["volume-1"],
      sandboxes: ["sandbox-1"],
      usageUsers: ["user-1"],
      processes: ["replica-a"],
    });
  });
});
