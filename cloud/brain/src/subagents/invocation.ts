import type { SubagentType } from "./types.ts";

export type AgentExecutionBackend = "sandbox" | "service" | "remote" | "workflow";
export type AgentRunMode = "foreground" | "background" | "scheduled";

export interface AgentInvocation {
  operationId: string;
  attempt: number;
  userId: string;
  sessionId: string;
  agentType: SubagentType;
  executionBackend: AgentExecutionBackend;
  runMode: AgentRunMode;
  prompt: string;
  description: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface AgentInvocationTemplate {
  version: 1;
  agentType: SubagentType;
  executionBackend: AgentExecutionBackend;
  prompt: string;
  description: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  profileOverrides?: {
    promptMode?: "replace" | "append";
    maxTurns?: number;
    toolNames?: string[];
  };
}

export type CreateAgentInvocationOptions =
  Omit<AgentInvocation, "operationId" | "attempt" | "runMode">
  & Partial<Pick<AgentInvocation, "operationId" | "attempt" | "runMode">>;

export type AgentInvocationBackendHandler<T> = (invocation: AgentInvocation) => Promise<T>;

export type AgentInvocationBackendHandlers<T> = Record<
  AgentExecutionBackend,
  AgentInvocationBackendHandler<T>
>;

export function createAgentInvocation(options: CreateAgentInvocationOptions): AgentInvocation {
  return {
    ...options,
    operationId: options.operationId ?? `agent:${crypto.randomUUID()}`,
    attempt: options.attempt ?? 1,
    runMode: options.runMode ?? "foreground",
  };
}

export function createAgentInvocationTemplate(
  options: Omit<AgentInvocationTemplate, "version">,
): AgentInvocationTemplate {
  return { version: 1, ...options };
}

export function dispatchAgentInvocation<T>(
  invocation: AgentInvocation,
  handlers: AgentInvocationBackendHandlers<T>,
): Promise<T> {
  return handlers[invocation.executionBackend](invocation);
}
