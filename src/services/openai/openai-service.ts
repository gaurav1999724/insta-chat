import OpenAI from "openai";

import { env } from "@/lib/validation/env";
import { buildConversationContents, buildSystemInstruction } from "@/lib/gemini/prompt-builder";
import { validateAIResponse } from "@/lib/gemini/response-validator";
import { getAIGenerationContext } from "@/lib/conversations/get-ai-context";
import { logOperation } from "@/lib/logging/logger";

export class OpenAIApiError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "OpenAIApiError";
    this.details = details;
  }
}

function getClient(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new OpenAIApiError("ChatGPT is not configured on this server (missing OPENAI_API_KEY).");
  }
  return new OpenAI({ apiKey: env.OPENAI_API_KEY });
}

export async function generateResponseWithOpenAI(conversationId: string) {
  const startedAt = Date.now();

  try {
    const context = await getAIGenerationContext(conversationId);
    const contents = buildConversationContents(context.recentMessages);

    if (contents.length === 0) {
      throw new OpenAIApiError("No conversation history to respond to.");
    }

    const client = getClient();
    const response = await client.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: context.temperature,
      messages: [
        { role: "system", content: buildSystemInstruction(context) },
        ...contents.map((content) => ({
          role: content.role === "user" ? ("user" as const) : ("assistant" as const),
          content: content.parts?.map((part) => part.text ?? "").join("") ?? "",
        })),
      ],
    });

    const text = response.choices[0]?.message.content?.trim();
    if (!text) {
      throw new OpenAIApiError("ChatGPT returned an empty response.", response);
    }

    const validation = validateAIResponse(text, context.language);
    if (!validation.valid) {
      throw new OpenAIApiError(`AI response failed validation: ${validation.detail}`, validation);
    }

    const durationMs = Date.now() - startedAt;
    logOperation({
      conversationId,
      operation: "ai.openai_generate",
      status: "success",
      durationMs,
      errorCode: `model_${env.OPENAI_MODEL}`,
    });

    return {
      text,
      confidence: 0.75,
      provider: "OPENAI" as const,
      model: env.OPENAI_MODEL,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
      durationMs,
    };
  } catch (error) {
    logOperation({
      conversationId,
      operation: "ai.openai_generate",
      status: "failure",
      durationMs: Date.now() - startedAt,
      errorCode: "OPENAI_ERROR",
      detail: error instanceof Error ? error.message : "Unknown ChatGPT error.",
    });
    throw error;
  }
}
