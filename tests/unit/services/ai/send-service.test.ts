import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstagramApiError } from "@/lib/instagram/errors";
import { SEND_NOT_SUPPORTED_MESSAGE } from "@/lib/instagram/send-eligibility";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    message: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    messageDelivery: { create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    aPIError: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { checkRateLimit } = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/security/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/security/rate-limit")>(
    "@/lib/security/rate-limit",
  );
  return { ...actual, checkRateLimit };
});

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@/services/instagram/instagram-service", () => ({ sendMessage }));

const { sendManualMessage, SendMessageError } =
  await import("@/services/ai/send-service");

const activeConversation = {
  id: "conversation-1",
  externalConversationId: "contact-1",
  instagramAccount: {
    status: "ACTIVE",
    instagramUserId: "acc_1",
  },
};

const RECENT_INBOUND = { createdAt: new Date(Date.now() - 60 * 60 * 1000) }; // 1 hour ago

describe("sendManualMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true });
    prismaMock.conversation.findUnique.mockResolvedValue(activeConversation);
    prismaMock.message.findFirst.mockResolvedValue(RECENT_INBOUND);
    prismaMock.message.create.mockResolvedValue({ id: "message-1" });
    prismaMock.$transaction.mockResolvedValue(undefined);
  });

  it("throws when the conversation doesn't exist or isn't owned", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(null);

    await expect(sendManualMessage("missing-conversation", "hi")).rejects.toThrow(
      "Conversation not found.",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to send and logs RATE_LIMIT_ERROR when the conversation is rate limited", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 300 });

    await expect(sendManualMessage("conversation-1", "hi", "user-1")).rejects.toThrow(
      /Too many messages sent/,
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(prismaMock.aPIError.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "RATE_LIMIT_ERROR" }),
      }),
    );
  });

  it("refuses to send when the Instagram account isn't connected (spec §41 eligibility)", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...activeConversation,
      instagramAccount: {
        ...activeConversation.instagramAccount,
        status: "DISCONNECTED",
      },
    });

    await expect(sendManualMessage("conversation-1", "hi")).rejects.toThrow(
      "Instagram account is not connected.",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to send outside the 24-hour messaging window (spec §41)", async () => {
    prismaMock.message.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    await expect(sendManualMessage("conversation-1", "hi")).rejects.toThrow(
      SEND_NOT_SUPPORTED_MESSAGE,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends the message and returns the persisted messageId on success", async () => {
    sendMessage.mockResolvedValue({ externalMessageId: "mid.sent.1" });

    const result = await sendManualMessage("conversation-1", "Haan bilkul!", "user-1");

    expect(result).toEqual({ messageId: "message-1" });
    expect(sendMessage).toHaveBeenCalledWith("acc_1", "contact-1", "Haan bilkul!");
    expect(prismaMock.$transaction).toHaveBeenCalled();
  });

  it("throws the InstagramApiError's own message and logs INSTAGRAM_API_ERROR on send failure", async () => {
    sendMessage.mockRejectedValue(
      new InstagramApiError("Rate limited by Meta", "INSTAGRAM_API_ERROR"),
    );

    await expect(sendManualMessage("conversation-1", "hi", "user-1")).rejects.toThrow(
      "Rate limited by Meta",
    );
    expect(prismaMock.aPIError.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "INSTAGRAM_API_ERROR" }),
      }),
    );
  });

  it("throws a generic message for a non-InstagramApiError send failure", async () => {
    sendMessage.mockRejectedValue(new Error("fetch failed"));

    await expect(sendManualMessage("conversation-1", "hi")).rejects.toThrow(
      "Failed to send the message.",
    );
  });

  it("always throws SendMessageError, never the raw underlying error", async () => {
    sendMessage.mockRejectedValue(new Error("fetch failed"));

    await expect(sendManualMessage("conversation-1", "hi")).rejects.toBeInstanceOf(
      SendMessageError,
    );
  });
});
