import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@piclaw/agent-kernel";
import type { CloudKernelRuntime } from "@piclaw/agent-kernel";
import { CLOUD_KERNEL_PROVIDER_ID } from "@piclaw/agent-kernel";
import { resolveMockCompletionForContext } from "../llm/mock-completion.ts";
import type { CompletionRound } from "../llm.ts";

const MOCK_MODEL_ID = "piclaw-mock";

function lastUserPrompt(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === "user") {
      const content = message.content;
      if (typeof content === "string") return content;
      return content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    }
  }
  return "";
}

function isSlowMockPrompt(prompt: string): boolean {
  return prompt.includes("slow doomed turn") || prompt.includes("medium first");
}

function completionRoundToAssistantMessage(round: CompletionRound, model: Model<string>): AssistantMessage {
  if (round.toolCalls.length > 0) {
    return fauxAssistantMessage(
      round.toolCalls.map((call) =>
        fauxToolCall(call.name, JSON.parse(call.arguments || "{}") as Record<string, unknown>, { id: call.id }),
      ),
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage(round.text, { stopReason: "stop" });
}

function cloneForModel(message: AssistantMessage, model: Model<string>): AssistantMessage {
  return {
    ...message,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
  };
}

/** Kernel runtime backed by deterministic mock completions (CLOUD_LLM_MOCK=1). */
export function createMockKernelRuntime(): CloudKernelRuntime {
  const makeFaux = (tokensPerSecond: number) =>
    fauxProvider({
      api: "faux",
      provider: CLOUD_KERNEL_PROVIDER_ID,
      models: [{ id: MOCK_MODEL_ID, name: "PiClaw Mock LLM", contextWindow: 128_000 }],
      tokensPerSecond,
    });

  const fastFaux = makeFaux(0);
  const slowFaux = makeFaux(0.25);

  const models = createModels();
  models.setProvider(fastFaux.provider);

  const baseStreamSimple = models.streamSimple.bind(models);

  const responseFactory =
    (model: Model<string>) =>
    async (ctx: Context, streamOptions?: SimpleStreamOptions) => {
      const round = await resolveMockCompletionForContext(ctx, {
        signal: streamOptions?.signal,
      });
      return cloneForModel(completionRoundToAssistantMessage(round, model), model);
    };

  models.streamSimple = (model, context, options) => {
    const active = isSlowMockPrompt(lastUserPrompt(context)) ? slowFaux : fastFaux;
    const activeModel = active.getModel(MOCK_MODEL_ID);
    if (!activeModel) {
      throw new Error("Mock kernel model not registered");
    }
    active.appendResponses([responseFactory(activeModel)]);
    models.setProvider(active.provider);
    return baseStreamSimple(activeModel, context, options);
  };

  const model = fastFaux.getModel(MOCK_MODEL_ID);
  if (!model) {
    throw new Error("Mock kernel model not registered");
  }

  return { models, model: model as CloudKernelRuntime["model"], providerId: CLOUD_KERNEL_PROVIDER_ID };
}
