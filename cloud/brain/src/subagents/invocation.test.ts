import { describe, expect, test } from "bun:test";
import {
  createAgentInvocation,
  createAgentInvocationTemplate,
  dispatchAgentInvocation,
  type AgentInvocationBackendHandlers,
} from "./invocation.ts";

describe("agent invocation contract", () => {
  test("creates a foreground invocation from an agent profile", () => {
    const invocation = createAgentInvocation({
      userId: "user-1",
      sessionId: "session-1",
      agentType: "general-purpose",
      executionBackend: "sandbox",
      prompt: "Implement the feature",
      description: "Implement feature",
    });

    expect(invocation.userId).toBe("user-1");
    expect(invocation.sessionId).toBe("session-1");
    expect(invocation.agentType).toBe("general-purpose");
    expect(invocation.executionBackend).toBe("sandbox");
    expect(invocation.runMode).toBe("foreground");
    expect(invocation.operationId).toStartWith("agent:");
    expect(invocation.attempt).toBe(1);
  });

  test("preserves stable identity across scheduled attempts", () => {
    const invocation = createAgentInvocation({
      operationId: "scheduled:task-1",
      attempt: 3,
      userId: "user-1",
      sessionId: "session-1",
      agentType: "explore",
      executionBackend: "service",
      runMode: "scheduled",
      prompt: "Find important AI news",
      description: "Daily AI news",
    });

    expect(invocation.operationId).toBe("scheduled:task-1");
    expect(invocation.attempt).toBe(3);
    expect(invocation.runMode).toBe("scheduled");
    expect(invocation.executionBackend).toBe("service");
  });

  test("dispatches only to the backend declared by the profile", async () => {
    const calls: string[] = [];
    const handlers: AgentInvocationBackendHandlers<string> = {
      sandbox: async () => {
        calls.push("sandbox");
        return "sandbox-result";
      },
      service: async () => {
        calls.push("service");
        return "service-result";
      },
      remote: async () => {
        calls.push("remote");
        return "remote-result";
      },
      workflow: async () => {
        calls.push("workflow");
        return "workflow-result";
      },
    };
    const invocation = createAgentInvocation({
      userId: "user-1",
      sessionId: "session-1",
      agentType: "explore",
      executionBackend: "service",
      prompt: "Inspect the repository",
      description: "Repository inspection",
    });

    const result = await dispatchAgentInvocation(invocation, handlers);

    expect(result).toBe("service-result");
    expect(calls).toEqual(["service"]);
  });

  test("creates a durable invocation template without runtime fencing fields", () => {
    expect(createAgentInvocationTemplate({
      agentType: "research",
      executionBackend: "service",
      prompt: "Find important AI news",
      description: "Daily AI news",
      maxTurns: 6,
    })).toEqual({
      version: 1,
      agentType: "research",
      executionBackend: "service",
      prompt: "Find important AI news",
      description: "Daily AI news",
      maxTurns: 6,
    });
  });
});
