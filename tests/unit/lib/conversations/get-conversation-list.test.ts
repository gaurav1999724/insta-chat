import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { conversation: { findMany: vi.fn() } },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { getConversationList, parseStatusFilter } =
  await import("@/lib/conversations/get-conversation-list");

describe("parseStatusFilter", () => {
  it.each(["all", "ai", "human", "unread", "active"] as const)(
    "accepts the valid status %s",
    (status) => {
      expect(parseStatusFilter(status)).toBe(status);
    },
  );

  it("falls back to 'all' for an unrecognized value", () => {
    expect(parseStatusFilter("not-a-real-status")).toBe("all");
  });

  it("falls back to 'all' when undefined", () => {
    expect(parseStatusFilter(undefined)).toBe("all");
  });
});

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    status: "ACTIVE",
    aiEnabled: true,
    humanTakeover: false,
    lastMessageAt: new Date("2026-09-17T10:00:00Z"),
    lastReadAt: null,
    chatMode: null,
    participant: { username: "someuser", displayName: null, profilePictureUrl: null },
    messages: [{ text: "hey", direction: "INBOUND" }],
    ...overrides,
  };
}

describe("getConversationList (spec §74 authorization)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always scopes the query through the owning user's InstagramAccount", async () => {
    prismaMock.conversation.findMany.mockResolvedValue([]);

    await getConversationList("user-1");

    expect(prismaMock.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ instagramAccount: { userId: "user-1" } }),
      }),
    );
  });

  it("marks a conversation unread when the last message is inbound and newer than lastReadAt", async () => {
    prismaMock.conversation.findMany.mockResolvedValue([conversation()]);

    const [item] = await getConversationList("user-1");
    expect(item.unread).toBe(true);
  });

  it("marks a conversation read when the last message is outbound", async () => {
    prismaMock.conversation.findMany.mockResolvedValue([
      conversation({ messages: [{ text: "hi", direction: "OUTBOUND" }] }),
    ]);

    const [item] = await getConversationList("user-1");
    expect(item.unread).toBe(false);
  });

  it("marks a conversation read when lastReadAt is after the last message", async () => {
    prismaMock.conversation.findMany.mockResolvedValue([
      conversation({ lastReadAt: new Date("2026-09-17T11:00:00Z") }),
    ]);

    const [item] = await getConversationList("user-1");
    expect(item.unread).toBe(false);
  });

  it("applies the 'unread' filter in application code after the query", async () => {
    prismaMock.conversation.findMany.mockResolvedValue([
      conversation({ id: "unread-1" }),
      conversation({ id: "read-1", messages: [{ text: "hi", direction: "OUTBOUND" }] }),
    ]);

    const items = await getConversationList("user-1", { status: "unread" });
    expect(items.map((item) => item.id)).toEqual(["unread-1"]);
  });

  it("adds an aiEnabled filter for the 'ai' status", async () => {
    prismaMock.conversation.findMany.mockResolvedValue([]);

    await getConversationList("user-1", { status: "ai" });

    expect(prismaMock.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ aiEnabled: true }),
      }),
    );
  });

  it("searches username, display name, and message text (case-insensitive)", async () => {
    prismaMock.conversation.findMany.mockResolvedValue([]);

    await getConversationList("user-1", { search: "priya" });

    const { where } = prismaMock.conversation.findMany.mock.calls[0][0];
    expect(where.OR).toEqual([
      { participant: { username: { contains: "priya", mode: "insensitive" } } },
      { participant: { displayName: { contains: "priya", mode: "insensitive" } } },
      { messages: { some: { text: { contains: "priya", mode: "insensitive" } } } },
    ]);
  });
});
