/**
 * Kernel-backed subagent loop — unified inner loop for all subagent types.
 */
import * as store from "@piclaw-cloud/store";
import { config } from "../config.ts";
import { publish } from "../events.ts";
import { isLlmMockEnabled, type LlmUsage } from "../llm.ts";
import { runAgentSessionLoop } from "../kernel/run-session-loop.ts";
import { getKernelRuntime, isKernelConfigured } from "../kernel/runtime.ts";
import { subagentRowsToAgentMessages } from "../kernel/subagent-message-map.ts";
import { pollSteerMessage } from "./channels.ts";
import {
  buildSubagentUserPrompt,
  resolveSubagentProfile,
  type ProfileOverrides,
} from "./profiles.ts";
import { runLegacySubagentLoop } from "./legacy-subagent-loop.ts";
import type { SubagentType } from "./types.ts";

export interface SubagentLoopOptions {
  agentType: SubagentType;
  prompt: string;
  constraints?: string;
  maxTurns?: number;
  profileOverrides?: ProfileOverrides;
  parentSystemAppend?: string;
}

export interface SubagentLoopResult {
  summary: string;
  artifacts: string[];
  usage: LlmUsage;
  toolCount: number;
}

function shouldUseKernelLoop(): boolean {
  return !isLlmMockEnabled() && isKernelConfigured();
}

function extractArtifacts(summary: string, task: string): string[] {
  const artifacts: string[] = [];
  const pathRe = /(?:\/workspace\/[\w./-]+|\.\/[\w./-]+|[\w./-]+\.(ino|ts|js|py|json|md)\b)/g;
  for (const match of summary.matchAll(pathRe)) {
    const path = match[0].replace(/^\.\//, "").replace(/^\/workspace\//, "");
    if (!artifacts.includes(path)) artifacts.push(path);
  }
  if (task.startsWith("mock-coding:") && artifacts.length === 0) {
    artifacts.push("mock-output.txt");
  }
  return artifacts;
}

export async function runSubagentLoop(
  sessionId: string,
  runId: string,
  options: SubagentLoopOptions,
): Promise<SubagentLoopResult> {
  if (!shouldUseKernelLoop()) {
    const legacy = await runLegacySubagentLoop(sessionId, runId, options.agentType, options.prompt, {
      maxTurns: options.maxTurns,
      constraints: options.constraints,
    });
    return legacy;
  }

  const kernel = getKernelRuntime();
  if (!kernel) {
    throw new Error("Agent kernel is not initialized");
  }

  const profile = await resolveSubagentProfile(options.agentType, sessionId, {
    maxTurns: options.maxTurns,
    ...options.profileOverrides,
  });
  const tools = await profile.resolveTools(sessionId);
  const userContent = buildSubagentUserPrompt(
    profile,
    options.prompt,
    options.constraints,
    options.parentSystemAppend,
  );

  const existing = await store.listSubagentMessages(runId);
  let messages = subagentRowsToAgentMessages(existing, kernel.model.id);
  if (messages.length === 0) {
    await store.insertSubagentMessage(runId, "user", userContent);
    messages = [{ role: "user", content: userContent, timestamp: Date.now() }];
  }

  const loop = await runAgentSessionLoop({
    persist: { kind: "subagent", sessionId, runId },
    messages,
    systemPrompt: profile.systemPrompt,
    mode: profile.mode,
    toolDefinitions: tools,
    maxTurns: profile.maxTurns,
    pollSteer: () => pollSteerMessage(runId),
    onSteerApplied: async (message) => {
      await publish(sessionId, {
        type: "subagent_steered",
        runId,
        message,
        replica: config.replicaId,
      });
    },
    onPlanUpdate:
      options.agentType === "plan"
        ? async (text) => {
            await store.setSessionPlanText(sessionId, text);
            await publish(sessionId, {
              type: "plan_update",
              text,
              replica: config.replicaId,
            });
          }
        : undefined,
  });

  const summary = loop.finalText.trim() || "Subagent completed.";
  const artifacts =
    profile.mode === "execute" ? extractArtifacts(summary, options.prompt) : [];

  return {
    summary,
    artifacts,
    usage: loop.usage,
    toolCount: loop.toolCount,
  };
}
