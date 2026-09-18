import { prisma } from "@/lib/db/prisma";
import { GeminiApiError } from "@/lib/gemini/errors";
import {
  analyzeCommunicationStyle,
  extractMemory,
} from "@/services/gemini/gemini-service";

export type AnalyzeConversationResult =
  | { success: true; memoryFactCount: number; styleFactCount: number }
  | { success: false; error: string };

// Shared by the "Analyze conversation" server action
// (src/app/conversations/actions.ts) and the automatic `memory-extraction`
// queue worker — same reasoning as `draft-service.ts`. `userId` is only
// present when called from a real session.
export async function runConversationAnalysis(
  conversationId: string,
  userId?: string,
): Promise<AnalyzeConversationResult> {
  try {
    const [memoryFacts, style] = await Promise.all([
      extractMemory(conversationId),
      analyzeCommunicationStyle(conversationId).catch(() => null),
    ]);

    await Promise.all(
      memoryFacts.map((fact) =>
        prisma.conversationMemory.upsert({
          where: {
            conversationId_category_key: {
              conversationId,
              category: fact.category,
              key: fact.key,
            },
          },
          update: { value: fact.value, confidence: fact.confidence },
          create: {
            conversationId,
            category: fact.category,
            key: fact.key,
            value: fact.value,
            confidence: fact.confidence,
          },
        }),
      ),
    );

    let styleFactCount = 0;
    if (style) {
      const rawStyleEntries: Array<[string, string]> = [
        ["averageMessageLength", style.averageMessageLength],
        ["emojiUsage", style.emojiUsage],
        ["languageMix", style.languageMix],
        ["punctuationStyle", style.punctuationStyle],
        ["formality", style.formality],
        ["commonExpressions", style.commonExpressions.join(", ")],
      ];
      const styleEntries = rawStyleEntries.filter(([, value]) => value.length > 0);

      await Promise.all(
        styleEntries.map(([key, value]) =>
          prisma.conversationMemory.upsert({
            where: {
              conversationId_category_key: {
                conversationId,
                category: "communication_style",
                key,
              },
            },
            update: { value, confidence: 0.7 },
            create: {
              conversationId,
              category: "communication_style",
              key,
              value,
              confidence: 0.7,
            },
          }),
        ),
      );
      styleFactCount = styleEntries.length;
    }

    if (memoryFacts.length > 0 || styleFactCount > 0) {
      await prisma.auditLog.create({
        data: {
          userId,
          action: "MEMORY_CHANGED",
          entityType: "Conversation",
          entityId: conversationId,
        },
      });
    }

    return { success: true, memoryFactCount: memoryFacts.length, styleFactCount };
  } catch (error) {
    const message =
      error instanceof GeminiApiError
        ? error.message
        : "Unexpected error analyzing the conversation.";

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

    return { success: false, error: message };
  }
}
