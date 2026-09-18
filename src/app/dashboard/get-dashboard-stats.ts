import { prisma } from "@/lib/db/prisma";

export type DashboardStats = {
  connectedAccountUsername: string | null;
  activeConversations: number;
  aiEnabledConversations: number;
  humanTakeoverConversations: number;
  messagesToday: number;
  aiGeneratedMessages: number;
  geminiTokensTotal: number;
  errorCount: number;
};

// Every query is scoped to `userId` (spec §74: authorization) — a
// conversation is only ever reachable through the InstagramAccount that
// owns it, which in turn belongs to exactly one user.
export async function getDashboardStats(userId: string): Promise<DashboardStats> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [
    connectedAccount,
    activeConversations,
    aiEnabledConversations,
    humanTakeoverConversations,
    messagesToday,
    aiGeneratedMessages,
    geminiUsage,
    errorCount,
  ] = await Promise.all([
    prisma.instagramAccount.findFirst({
      where: { userId, status: "ACTIVE" },
      select: { username: true },
    }),
    prisma.conversation.count({
      where: { instagramAccount: { userId }, status: "ACTIVE" },
    }),
    prisma.conversation.count({
      where: { instagramAccount: { userId }, aiEnabled: true },
    }),
    prisma.conversation.count({
      where: { instagramAccount: { userId }, humanTakeover: true },
    }),
    prisma.message.count({
      where: {
        conversation: { instagramAccount: { userId } },
        createdAt: { gte: startOfToday },
      },
    }),
    prisma.message.count({
      where: {
        conversation: { instagramAccount: { userId } },
        senderType: "AI",
      },
    }),
    prisma.aIUsage.aggregate({
      where: { conversation: { instagramAccount: { userId } } },
      _sum: { totalTokens: true },
    }),
    prisma.aPIError.count({ where: { userId } }),
  ]);

  return {
    connectedAccountUsername: connectedAccount?.username ?? null,
    activeConversations,
    aiEnabledConversations,
    humanTakeoverConversations,
    messagesToday,
    aiGeneratedMessages,
    geminiTokensTotal: geminiUsage._sum.totalTokens ?? 0,
    errorCount,
  };
}
