import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/validation/env";
import type { AIProvider } from "@prisma/client";
import type { PromptContext } from "@/lib/gemini/prompt-builder";

export type AIGenerationContext = PromptContext & {
  model: string;
  aiProvider: AIProvider;
  temperature: number;
  maxContextMessages: number;
  totalMessageCount: number;
  latestSummary: { summary: string; messageRangeEnd: Date } | null;
};

// Pure data-gathering — no Gemini calls here. GeminiService (which does
// call Gemini) is the caller, so it can also decide whether the existing
// summary is stale and needs regenerating (spec §45/§46) without this
// module needing to import GeminiService back (that would be circular).
export async function getAIGenerationContext(
  conversationId: string,
): Promise<AIGenerationContext> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: {
      participant: {
        select: { username: true, displayName: true },
      },
      settings: true,
      chatMode: { select: { name: true, personalityInstructions: true } },
      instagramAccount: {
        select: {
          user: {
            select: {
              aiConfiguration: {
                include: {
                  defaultChatMode: {
                    select: { name: true, personalityInstructions: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const aiConfig = conversation.instagramAccount.user.aiConfiguration;
  const settings = conversation.settings;
  // spec §32: conversation-level chat mode overrides the user's global
  // default; fall back to that default when the conversation has none set.
  const chatMode = conversation.chatMode ?? aiConfig?.defaultChatMode ?? null;

  const maxContextMessages =
    settings?.maxContextMessages ?? aiConfig?.maxContextMessages ?? 20;

  const [recentMessages, totalMessageCount, memories, latestSummary] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId, senderType: { not: "SYSTEM" } },
      orderBy: { createdAt: "desc" },
      take: maxContextMessages,
      select: { senderType: true, direction: true, text: true },
    }),
    prisma.message.count({ where: { conversationId, senderType: { not: "SYSTEM" } } }),
    prisma.conversationMemory.findMany({
      where: { conversationId },
      orderBy: { confidence: "desc" },
      take: 20,
      select: { category: true, key: true, value: true },
    }),
    prisma.conversationSummary.findFirst({
      where: { conversationId },
      orderBy: { messageRangeEnd: "desc" },
      select: { summary: true, messageRangeEnd: true },
    }),
  ]);

  recentMessages.reverse();

  return {
    chatMode,
    language: settings?.language ?? aiConfig?.language ?? "HINGLISH",
    responseLength: settings?.responseLength ?? aiConfig?.responseLength ?? "SHORT",
    emojiLevel: settings?.emojiLevel ?? aiConfig?.emojiLevel ?? "MEDIUM",
    customInstructions: settings?.customInstructions ?? null,
    contactProfile: {
      preferredName: settings?.preferredName ?? null,
      relationshipLabel: settings?.relationshipLabel ?? null,
      username: conversation.participant.username,
      displayName: conversation.participant.displayName,
    },
    memories,
    conversationSummary: latestSummary?.summary ?? null,
    recentMessages,
    model: aiConfig?.model ?? env.GEMINI_MODEL,
    aiProvider: aiConfig?.aiProvider ?? "AUTO",
    temperature: aiConfig?.temperature ?? 0.9,
    maxContextMessages,
    totalMessageCount,
    latestSummary: latestSummary ?? null,
  };
}
