import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn() },
    aIConfiguration: { findUnique: vi.fn() },
    aIResponse: { update: vi.fn() },
    aPIError: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { createDraftReply } = vi.hoisted(() => ({ createDraftReply: vi.fn() }));
vi.mock("@/services/ai/draft-service", () => ({ createDraftReply }));

const { sendApprovedDraft } = vi.hoisted(() => ({ sendApprovedDraft: vi.fn() }));
vi.mock("@/services/ai/send-service", () => ({ sendApprovedDraft }));

const { maybeAutoRespond } = await import("@/services/ai/auto-respond-service");

const activeConversation = {
  aiEnabled: true,
  humanTakeover: false,
  settings: { autoSend: true },
  instagramAccount: { userId: "user-1" },
  messages: [{ id: "trigger-message-1", direction: "INBOUND" }],
};

describe("maybeAutoRespond", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.aIResponse.update.mockResolvedValue({});
  });

  it("does nothing when the conversation doesn't exist", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(null);

    await maybeAutoRespond("conversation-1");

    expect(createDraftReply).not.toHaveBeenCalled();
  });

  it("does nothing when AI is disabled for the conversation", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...activeConversation,
      aiEnabled: false,
    });

    await maybeAutoRespond("conversation-1");

    expect(createDraftReply).not.toHaveBeenCalled();
  });

  it("does nothing when a human has taken over", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...activeConversation,
      humanTakeover: true,
    });

    await maybeAutoRespond("conversation-1");

    expect(createDraftReply).not.toHaveBeenCalled();
  });

  it("does nothing when the per-conversation override explicitly disables auto-send", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...activeConversation,
      settings: { autoSend: false },
    });

    await maybeAutoRespond("conversation-1");

    expect(createDraftReply).not.toHaveBeenCalled();
    expect(prismaMock.aIConfiguration.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the global AIConfiguration default when there's no per-conversation override", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...activeConversation,
      settings: { autoSend: null },
    });
    prismaMock.aIConfiguration.findUnique.mockResolvedValue({ autoSend: true });
    createDraftReply.mockResolvedValue({
      success: true,
      aiResponseId: "ai-response-1",
      text: "Haan bilkul!",
      confidence: 0.8,
    });
    sendApprovedDraft.mockResolvedValue({ messageId: "message-1" });

    await maybeAutoRespond("conversation-1");

    expect(prismaMock.aIConfiguration.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { autoSend: true },
    });
    expect(createDraftReply).toHaveBeenCalledWith(
      "conversation-1",
      undefined,
      "trigger-message-1",
    );
  });

  it("does nothing when both the override and the global default are off", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...activeConversation,
      settings: { autoSend: null },
    });
    prismaMock.aIConfiguration.findUnique.mockResolvedValue({ autoSend: false });

    await maybeAutoRespond("conversation-1");

    expect(createDraftReply).not.toHaveBeenCalled();
  });

  it("generates a draft, auto-approves it, and sends it with no human gate", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(activeConversation);
    createDraftReply.mockResolvedValue({
      success: true,
      aiResponseId: "ai-response-1",
      text: "Haan bilkul!",
      confidence: 0.8,
    });
    sendApprovedDraft.mockResolvedValue({ messageId: "message-1" });

    await maybeAutoRespond("conversation-1");

    expect(createDraftReply).toHaveBeenCalledWith(
      "conversation-1",
      undefined,
      "trigger-message-1",
    );
    expect(prismaMock.aIResponse.update).toHaveBeenCalledWith({
      where: { id: "ai-response-1" },
      data: { status: "APPROVED" },
    });
    expect(sendApprovedDraft).toHaveBeenCalledWith("ai-response-1");
  });

  it("does not attempt to send when draft generation itself failed", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(activeConversation);
    createDraftReply.mockResolvedValue({ success: false, error: "Gemini is down" });

    await maybeAutoRespond("conversation-1");

    expect(prismaMock.aIResponse.update).not.toHaveBeenCalled();
    expect(sendApprovedDraft).not.toHaveBeenCalled();
  });

  it("swallows a send failure rather than throwing, and records it", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(activeConversation);
    createDraftReply.mockResolvedValue({
      success: true,
      aiResponseId: "ai-response-1",
      text: "Haan bilkul!",
      confidence: 0.8,
    });
    sendApprovedDraft.mockRejectedValue(new Error("Failed to send the Instagram message."));

    await expect(maybeAutoRespond("conversation-1")).resolves.toBeUndefined();

    expect(prismaMock.aPIError.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: "INSTAGRAM_API_ERROR",
          conversationId: "conversation-1",
        }),
      }),
    );
  });
});
