import { prisma } from "@/lib/db/prisma";

export type RecentError = {
  id: string;
  category: string;
  message: string;
  createdAt: Date;
};

// spec §51/§52's "store technical details server-side" only helps if
// there's somewhere to read them back from — this is that read side.
// Scoped to `userId` directly (`APIError.userId`), not through
// `InstagramAccount` like conversation-scoped queries, since an error can
// happen before any account/conversation context exists (e.g. a failed
// OAuth connect attempt).
export async function getRecentErrors(
  userId: string,
  limit = 25,
): Promise<RecentError[]> {
  return prisma.aPIError.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, category: true, message: true, createdAt: true },
  });
}
