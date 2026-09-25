import { Prisma, type ErrorCategory } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { GeminiApiError } from "@/lib/gemini/errors";
import { estimateCostUsd } from "@/lib/gemini/pricing";
import { logOperation } from "@/lib/logging/logger";
import { checkRateLimit, formatRetryAfter } from "@/lib/security/rate-limit";
import { generateReply } from "@/services/ai/response-service";
import { OpenAIApiError } from "@/services/openai/openai-service";

export type CreateDraftResult =
  | {
      success: true;
      aiResponseId: string;
      text: string;
      confidence: number;
      provider: "GEMINI" | "OPENAI";
    }
  | { success: false; error: string };

// Shared by the "AI Generate" server action
// (src/app/conversations/actions.ts) and the automatic `ai-response` queue
// worker (src/lib/queue/workers/ai-response-worker.ts) — both paths call
// this so they can never drift apart. `userId` is only available from the
// action (a real session); the worker runs with no user context, so it's
// optional and `AuditLog.userId`/`APIError.userId` are nullable for
// exactly this reason.
export async function createDraftReply(
  conversationId: string,
  userId?: string,
  triggerMessageId?: string,
): Promise<CreateDraftResult> {
  // spec §50: rate limit AI generation. Keyed per conversation (not per
  // user) since that's the one scope both the manual "AI Generate" button
  // and the automatic `ai-response` worker (which has no `userId`) always
  // have in common — see PROJECT_ANALYSIS.md §9d.
  const rateLimit = await checkRateLimit("AI_GENERATION", conversationId);
  if (!rateLimit.allowed) {
    const message = `Too many AI replies requested for this conversation — try again in ${formatRetryAfter(rateLimit.retryAfterSeconds)}.`;
    await prisma.aPIError.create({
      data: { category: "RATE_LIMIT_ERROR", message, userId, conversationId },
    });
    logOperation({
      userId,
      conversationId,
      operation: "ai.generate_response",
      status: "failure",
      errorCode: "RATE_LIMIT_ERROR",
      detail: message,
    });
    return { success: false, error: message };
  }

  try {
    const triggerMessage = await prisma.message.findFirst({
      where: {
        conversationId,
        direction: "INBOUND",
        ...(triggerMessageId ? { id: triggerMessageId } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (!triggerMessage || (triggerMessageId && triggerMessage.id !== triggerMessageId)) {
      return { success: false, error: "The conversation has no eligible inbound message." };
    }

    const result = await generateReply(conversationId);

    const aiResponse = await prisma.aIResponse.create({
      data: {
        conversationId,
        triggerMessageId: triggerMessage?.id,
        text: result.text,
        confidence: result.confidence,
        provider: result.provider,
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        durationMs: result.durationMs,
      },
    });

    const estimatedCostUsd = estimateCostUsd(
      result.model,
      result.promptTokens ?? 0,
      result.completionTokens ?? 0,
    );

    await prisma.$transaction([
      prisma.aIUsage.create({
        data: {
          conversationId,
          aiResponseId: aiResponse.id,
          provider: result.provider,
          model: result.model,
          inputTokens: result.promptTokens ?? 0,
          outputTokens: result.completionTokens ?? 0,
          totalTokens: result.totalTokens ?? 0,
          durationMs: result.durationMs,
          estimatedCostUsd,
        },
      }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "AI_RESPONSE_GENERATED",
          entityType: "AIResponse",
          entityId: aiResponse.id,
        },
      }),
    ]);

    logOperation({
      userId,
      conversationId,
      messageId: aiResponse.id,
      operation: "ai.generate_response",
      status: "success",
      durationMs: result.durationMs,
    });

    return {
      success: true,
      aiResponseId: aiResponse.id,
      text: aiResponse.text,
      confidence: aiResponse.confidence,
      provider: result.provider,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: "This inbound message already has a reply." };
    }

    const message =
      error instanceof GeminiApiError || error instanceof OpenAIApiError
        ? error.message
        : "Unexpected error generating a reply.";
    // Both providers can throw here (response-service.ts tries Gemini then
    // falls back to OpenAI in AUTO mode) — categorize by whichever one
    // actually failed rather than hardcoding a single provider's category,
    // so this stays accurate regardless of which provider (or both) failed.
    const category: ErrorCategory =
      error instanceof GeminiApiError
        ? "GEMINI_ERROR"
        : error instanceof OpenAIApiError
          ? "OPENAI_ERROR"
          : "UNKNOWN_ERROR";

    await prisma.aPIError.create({
      data: {
        category,
        message,
        userId,
        conversationId,
        metadata: {
          details: error instanceof Error ? error.message : JSON.stringify(error),
        },
      },
    });

    logOperation({
      userId,
      conversationId,
      operation: "ai.generate_response",
      status: "failure",
      errorCode: category,
      detail: error instanceof Error ? error.message : message,
    });

    return { success: false, error: message };
  }
}
