import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SocialApiDmEvent } from "@/lib/instagram/webhook";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { processMessagingItem } = await import("@/services/instagram/webhook-processor");

type TxOverrides = {
  conversation?: { aiEnabled: boolean; humanTakeover: boolean; status: string };
  messageCount?: number;
};

function stubTransaction({
  conversation = { aiEnabled: true, humanTakeover: false, status: "ACTIVE" },
  messageCount = 1,
}: TxOverrides = {}) {
  const tx = {
    instagramParticipant: { upsert: vi.fn().mockResolvedValue({ id: "participant-1" }) },
    conversation: {
      upsert: vi.fn().mockResolvedValue({ id: "conversation-1", ...conversation }),
    },
    message: {
      upsert: vi.fn().mockResolvedValue({ id: "message-1" }),
      count: vi.fn().mockResolvedValue(messageCount),
    },
  };
  prismaMock.$transaction.mockImplementation(
    (callback: (tx: unknown) => unknown) => callback(tx),
  );
  return tx;
}

const baseEvent = (overrides: Partial<SocialApiDmEvent["data"]> = {}): SocialApiDmEvent => ({
  event: "dm.received",
  data: {
    id: "sapi_dm_1",
    type: "dm",
    platform: "instagram",
    account_id: "acc_1",
    conversation_id: "conv_1",
    platform_id: "m_1",
    author: { id: "contact-1", name: "Contact" },
    content: { text: "Hello there" },
    received_at: "2026-03-01T14:30:00Z",
    ...overrides,
  },
});

describe("processMessagingItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists an inbound text message", async () => {
    const tx = stubTransaction();

    const result = await processMessagingItem("account-1", baseEvent());

    expect(result).toEqual({
      processed: true,
      messageId: "message-1",
      conversationId: "conversation-1",
    });
    expect(tx.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          instagramAccountId_externalConversationId: {
            instagramAccountId: "account-1",
            externalConversationId: "conv_1",
          },
        },
      }),
    );
    expect(tx.message.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalMessageId: "m_1" },
        create: expect.objectContaining({
          senderType: "CONTACT",
          direction: "INBOUND",
          messageType: "TEXT",
          text: "Hello there",
        }),
      }),
    );
  });

  it("resolves an image message to messageType IMAGE with media in attachmentMetadata", async () => {
    const tx = stubTransaction();

    await processMessagingItem(
      "account-1",
      baseEvent({
        platform_id: "m_3",
        content: { media: [{ type: "image", url: "https://example.com/x.jpg" }] },
      }),
    );

    expect(tx.message.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          messageType: "IMAGE",
          attachmentMetadata: { media: [{ type: "image", url: "https://example.com/x.jpg" }] },
        }),
      }),
    );
  });

  // `dm.sent` is never passed to this function at all — the webhook route
  // filters it out before calling `processMessagingItem` (confirmed
  // 2026-09-21: processing it caused a real duplicate-message bug, since
  // SocialAPI.AI's echo reports Meta's raw message id, a different id
  // namespace than the one our own send call already recorded the message
  // under). Every event this function ever receives is inbound.
  it("always treats the message as inbound (dm.sent is filtered out upstream)", async () => {
    const tx = stubTransaction();

    await processMessagingItem("account-1", baseEvent({ platform_id: "m_4" }));

    expect(tx.message.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ senderType: "CONTACT", direction: "INBOUND" }),
      }),
    );
  });
});
