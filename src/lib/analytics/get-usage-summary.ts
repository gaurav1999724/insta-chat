import { prisma } from "@/lib/db/prisma";

export type UsageWindowStats = {
  totalTokens: number;
  estimatedCostUsd: number | null;
  aiResponseCount: number;
  messagesSent: number;
  messagesReceived: number;
  errorCount: number;
};

export type UsageSummary = {
  today: UsageWindowStats;
  last7Days: UsageWindowStats;
  last30Days: UsageWindowStats;
  allTime: UsageWindowStats;
};

// spec §31: "Create dashboard: Today, 7 days, 30 days, Total." All four
// windows are scoped to the user via `instagramAccount.userId` — the same
// ownership boundary every other cross-conversation query in this app
// uses (spec §74).
async function computeWindowStats(
  userId: string,
  since: Date | null,
): Promise<UsageWindowStats> {
  const createdAt = since ? { gte: since } : undefined;

  const [usage, messagesSent, messagesReceived, errorCount] = await Promise.all([
    prisma.aIUsage.aggregate({
      where: {
        conversation: { instagramAccount: { userId } },
        ...(createdAt && { createdAt }),
      },
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: true,
    }),
    prisma.message.count({
      where: {
        conversation: { instagramAccount: { userId } },
        direction: "OUTBOUND",
        ...(createdAt && { createdAt }),
      },
    }),
    prisma.message.count({
      where: {
        conversation: { instagramAccount: { userId } },
        direction: "INBOUND",
        ...(createdAt && { createdAt }),
      },
    }),
    prisma.aPIError.count({ where: { userId, ...(createdAt && { createdAt }) } }),
  ]);

  return {
    totalTokens: usage._sum.totalTokens ?? 0,
    estimatedCostUsd: usage._sum.estimatedCostUsd
      ? Number(usage._sum.estimatedCostUsd)
      : null,
    aiResponseCount: usage._count,
    messagesSent,
    messagesReceived,
    errorCount,
  };
}

export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [today, last7Days, last30Days, allTime] = await Promise.all([
    computeWindowStats(userId, startOfToday),
    computeWindowStats(userId, sevenDaysAgo),
    computeWindowStats(userId, thirtyDaysAgo),
    computeWindowStats(userId, null),
  ]);

  return { today, last7Days, last30Days, allTime };
}
