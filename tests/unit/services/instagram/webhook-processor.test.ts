import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InstagramWebhookMessagingItem } from "@/lib/instagram/webhook";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    message: { updateMany: vi.fn() },
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
      create: vi.fn().mockResolvedValue({ id: "message-1" }),
      count: vi.fn().mockResolvedValue(messageCount),
    },
  };
  prismaMock.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(tx),
  );
  return tx;
}

const baseItem = (overrides: Partial<InstagramWebhookMessagingItem> = {}) =>
  ({
    sender: { id: "contact-1" },
    recipient: { id: "account-1" },
    timestamp: 1700000000000,
    message: { mid: "mid.1", text: "Hello there" },
    ...overrides,
  }) as InstagramWebhookMessagingItem;

describe("processMessagingItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists an inbound text message", async () => {
    const tx = stubTransaction();

    const result = await processMessagingItem("account-1", baseItem());

    expect(result).toEqual({ processed: true, messageId: "message-1" });
    expect(tx.message.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalMessageId: "mid.1" },
        create: expect.objectContaining({
          senderType: "CONTACT",
          direction: "INBOUND",
          messageType: "TEXT",
          text: "Hello there",
        }),
      }),
    );
  });

  it("resolves an image attachment to messageType IMAGE", async () => {
    const tx = stubTransaction();

    await processMessagingItem(
      "account-1",
      baseItem({
        message: {
          mid: "mid.3",
          attachments: [{ type: "image", payload: { url: "https://example.com/x.jpg" } }],
        },
      }),
    );

    expect(tx.message.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ messageType: "IMAGE" }),
      }),
    );
  });

  it("marks a deleted message's text as null when the original is found (spec: message deletion)", async () => {
    prismaMock.message.updateMany.mockResolvedValue({ count: 1 });

    const result = await processMessagingItem(
      "account-1",
      baseItem({ message: { mid: "mid.1", is_deleted: true } }),
    );

    expect(prismaMock.message.updateMany).toHaveBeenCalledWith({
      where: { externalMessageId: "mid.1" },
      data: { text: null },
    });
    expect(result).toEqual({ processed: true, messageId: "mid.1" });
  });

  it("reports processed:false when a deleted message's original was never stored", async () => {
    prismaMock.message.updateMany.mockResolvedValue({ count: 0 });

    const result = await processMessagingItem(
      "account-1",
      baseItem({ message: { mid: "mid.404", is_deleted: true } }),
    );

    expect(result).toEqual({ processed: false, reason: "deleted-message-not-found" });
  });

});
