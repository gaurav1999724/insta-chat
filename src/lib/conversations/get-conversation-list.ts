import { prisma } from "@/lib/db/prisma";

export type ConversationStatusFilter = "all" | "ai" | "human" | "unread" | "active";

const VALID_STATUSES: ConversationStatusFilter[] = [
  "all",
  "ai",
  "human",
  "unread",
  "active",
];

export function parseStatusFilter(raw: string | undefined): ConversationStatusFilter {
  return VALID_STATUSES.includes(raw as ConversationStatusFilter)
    ? (raw as ConversationStatusFilter)
    : "all";
}

export type ConversationListItem = {
  id: string;
  status: string;
  aiEnabled: boolean;
  humanTakeover: boolean;
  lastMessageAt: Date | null;
  unread: boolean;
  chatModeName: string | null;
  participant: {
    username: string | null;
    displayName: string | null;
    profilePictureUrl: string | null;
  };
  latestMessage: { text: string | null; direction: string } | null;
};

// Filtering is done in application code, not SQL — "unread" is a
// same-row comparison (lastMessageAt vs lastReadAt) that isn't a plain
// Prisma where-clause, and a personal Instagram inbox is small enough that
// this is simpler than a raw query.
export async function getConversationList(
  userId: string,
  { status = "all", search }: { status?: ConversationStatusFilter; search?: string } = {},
): Promise<ConversationListItem[]> {
  const conversations = await prisma.conversation.findMany({
    where: {
      instagramAccount: { userId },
      ...(status === "ai" ? { aiEnabled: true } : {}),
      ...(status === "human" ? { humanTakeover: true } : {}),
      ...(status === "active" ? { status: "ACTIVE" } : {}),
      ...(search
        ? {
            OR: [
              { participant: { username: { contains: search, mode: "insensitive" } } },
              { participant: { displayName: { contains: search, mode: "insensitive" } } },
              { messages: { some: { text: { contains: search, mode: "insensitive" } } } },
            ],
          }
        : {}),
    },
    orderBy: { lastMessageAt: "desc" },
    include: {
      participant: {
        select: { username: true, displayName: true, profilePictureUrl: true },
      },
      chatMode: { select: { name: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { text: true, direction: true },
      },
    },
  });

  const items: ConversationListItem[] = conversations.map((conversation) => {
    const latestMessage = conversation.messages[0] ?? null;
    const unread =
      latestMessage?.direction === "INBOUND" &&
      conversation.lastMessageAt !== null &&
      (conversation.lastReadAt === null ||
        conversation.lastMessageAt > conversation.lastReadAt);

    return {
      id: conversation.id,
      status: conversation.status,
      aiEnabled: conversation.aiEnabled,
      humanTakeover: conversation.humanTakeover,
      lastMessageAt: conversation.lastMessageAt,
      unread,
      chatModeName: conversation.chatMode?.name ?? null,
      participant: conversation.participant,
      latestMessage: latestMessage
        ? { text: latestMessage.text, direction: latestMessage.direction }
        : null,
    };
  });

  return status === "unread" ? items.filter((item) => item.unread) : items;
}
