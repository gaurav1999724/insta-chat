import type { AIProvider } from "@prisma/client";

import { getAIGenerationContext } from "@/lib/conversations/get-ai-context";
import { generateResponse as generateGeminiResponse } from "@/services/gemini/gemini-service";
import { generateResponseWithOpenAI } from "@/services/openai/openai-service";

export async function generateReply(conversationId: string) {
  const context = await getAIGenerationContext(conversationId);

  if (context.aiProvider === "GEMINI") {
    return generateGeminiResponse(conversationId);
  }

  if (context.aiProvider === "OPENAI") {
    return generateResponseWithOpenAI(conversationId);
  }

  try {
    return await generateGeminiResponse(conversationId);
  } catch (geminiError) {
    try {
      return await generateResponseWithOpenAI(conversationId);
    } catch (openAIError) {
      throw new Error(
        `Gemini failed: ${getErrorMessage(geminiError)} ChatGPT fallback failed: ${getErrorMessage(openAIError)}`,
      );
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown provider error.";
}

export type ReplyProvider = AIProvider;
