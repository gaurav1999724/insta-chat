import { prisma } from "@/lib/db/prisma";
import { GeminiApiError } from "@/lib/gemini/errors";
import { estimateCostUsd } from "@/lib/gemini/pricing";
import { logOperation } from "@/lib/logging/logger";
import { checkRateLimit, formatRetryAfter } from "@/lib/security/rate-limit";
import { generateResponse } from "@/services/gemini/gemini-service";

export type CreateDraftResult =
  | { success: true; aiResponseId: string; text: string; confidence: number }
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
    });
    return { success: false, error: message };
  }

  try {
    const result = await generateResponse(conversationId);

    const triggerMessage = await prisma.message.findFirst({
      where: { conversationId, direction: "INBOUND" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    const aiResponse = await prisma.aIResponse.create({
      data: {
        conversationId,
        triggerMessageId: triggerMessage?.id,
        text: result.text,
        confidence: result.confidence,
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
    };
  } catch (error) {
    const message =
      error instanceof GeminiApiError
        ? error.message
        : "Unexpected error generating a reply.";

    await prisma.aPIError.create({
      data: {
        category: "GEMINI_ERROR",
        message,
        userId,
        conversationId,
        metadata:
          error instanceof GeminiApiError && error.details !== undefined
            ? { details: JSON.parse(JSON.stringify(error.details)) }
            : undefined,
      },
    });

    logOperation({
      userId,
      conversationId,
      operation: "ai.generate_response",
      status: "failure",
      errorCode: "GEMINI_ERROR",
    });

    return { success: false, error: message };
  }
}
