import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InstagramWebhookMessagingItem } from "@/lib/instagram/webhook";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    message: { updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { getAIResponseQueue, getMemoryExtractionQueue } = vi.hoisted(() => ({
  getAIResponseQueue: vi.fn(),
  getMemoryExtractionQueue: vi.fn(),
}));
vi.mock("@/lib/queue/queues", () => ({ getAIResponseQueue, getMemoryExtractionQueue }));

// Imported after the mocks above so `processMessagingItem` picks them up.
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
    getAIResponseQueue.mockReturnValue({ add: vi.fn() });
    getMemoryExtractionQueue.mockReturnValue({ add: vi.fn() });
  });

  it("persists an inbound text message and enqueues AI generation when eligible", async () => {
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
    expect(getAIResponseQueue().add).toHaveBeenCalledWith("generate", {
      conversationId: "conversation-1",
    });
  });

  it("does not enqueue AI generation for an echo (our own outbound) message", async () => {
    stubTransaction();

    await processMessagingItem(
      "account-1",
      baseItem({ message: { mid: "mid.2", text: "Sent from the app", is_echo: true } }),
    );

    expect(getAIResponseQueue().add).not.toHaveBeenCalled();
  });

  it("does not enqueue AI generation when the conversation has AI disabled", async () => {
    stubTransaction({
      conversation: { aiEnabled: false, humanTakeover: false, status: "ACTIVE" },
    });

    await processMessagingItem("account-1", baseItem());

    expect(getAIResponseQueue().add).not.toHaveBeenCalled();
  });

  it("does not enqueue AI generation during human takeover", async () => {
    stubTransaction({
      conversation: { aiEnabled: true, humanTakeover: true, status: "ACTIVE" },
    });

    await processMessagingItem("account-1", baseItem());

    expect(getAIResponseQueue().add).not.toHaveBeenCalled();
  });

  it("enqueues memory extraction every 10th message", async () => {
    stubTransaction({ messageCount: 10 });

    await processMessagingItem("account-1", baseItem());

    expect(getMemoryExtractionQueue().add).toHaveBeenCalledWith("analyze", {
      conversationId: "conversation-1",
    });
  });

  it("does not enqueue memory extraction on a non-multiple-of-10 message count", async () => {
    stubTransaction({ messageCount: 7 });

    await processMessagingItem("account-1", baseItem());

    expect(getMemoryExtractionQueue().add).not.toHaveBeenCalled();
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

  it("does not enqueue anything when Redis isn't configured (queues return null)", async () => {
    getAIResponseQueue.mockReturnValue(null);
    getMemoryExtractionQueue.mockReturnValue(null);
    stubTransaction({ messageCount: 10 });

    await expect(processMessagingItem("account-1", baseItem())).resolves.toEqual({
      processed: true,
      messageId: "message-1",
    });
  });
});
