import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requireUser } = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/require-user", () => ({ requireUser }));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    chatMode: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { createDraftReply } = vi.hoisted(() => ({ createDraftReply: vi.fn() }));
vi.mock("@/services/ai/draft-service", () => ({ createDraftReply }));

const { runConversationAnalysis } = vi.hoisted(() => ({
  runConversationAnalysis: vi.fn(),
}));
vi.mock("@/services/ai/memory-service", () => ({ runConversationAnalysis }));

const { sendApprovedDraft, sendManualMessage } = vi.hoisted(() => ({
  sendApprovedDraft: vi.fn(),
  sendManualMessage: vi.fn(),
}));
vi.mock("@/services/ai/send-service", () => ({
  sendApprovedDraft,
  sendManualMessage,
  SendMessageError: class SendMessageError extends Error {},
}));

const { generateDraftReply, sendManualMessageAction, setConversationChatMode } =
  await import("@/app/conversations/actions");

const SESSION_USER = { id: "user-1", email: "user@example.com" };

describe("authorization (spec §74): every action re-verifies conversation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(SESSION_USER);
  });

  it("generateDraftReply refuses an unowned/nonexistent conversation without calling the AI service", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);

    const result = await generateDraftReply("someone-elses-conversation");

    expect(result).toEqual({ success: false, error: "Conversation not found" });
    expect(createDraftReply).not.toHaveBeenCalled();
    expect(prismaMock.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "someone-elses-conversation",
          instagramAccount: { userId: "user-1" },
        },
      }),
    );
  });

  it("generateDraftReply proceeds for a conversation the user owns", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ id: "conversation-1" });
    createDraftReply.mockResolvedValue({
      success: true,
      aiResponseId: "ai-1",
      text: "hi",
      confidence: 0.5,
    });

    const result = await generateDraftReply("conversation-1");

    expect(result.success).toBe(true);
    expect(createDraftReply).toHaveBeenCalledWith("conversation-1", "user-1");
  });

  it("sendManualMessageAction refuses an unowned conversation without calling sendManualMessage", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);

    const result = await sendManualMessageAction("someone-elses-conversation", "hi");

    expect(result).toEqual({ success: false, error: "Conversation not found" });
    expect(sendManualMessage).not.toHaveBeenCalled();
  });

  it("sendManualMessageAction rejects an empty message before ever reaching the send service", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ id: "conversation-1" });

    const result = await sendManualMessageAction("conversation-1", "   ");

    expect(result.success).toBe(false);
    expect(sendManualMessage).not.toHaveBeenCalled();
  });

  it("sendManualMessageAction rejects a message over the length cap", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ id: "conversation-1" });

    const result = await sendManualMessageAction("conversation-1", "a".repeat(2001));

    expect(result.success).toBe(false);
    expect(sendManualMessage).not.toHaveBeenCalled();
  });

  it("sendManualMessageAction sends for an owned conversation with valid text", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ id: "conversation-1" });
    sendManualMessage.mockResolvedValue({ messageId: "message-1" });

    const result = await sendManualMessageAction("conversation-1", "Hello!");

    expect(result).toEqual({ success: true });
    expect(sendManualMessage).toHaveBeenCalledWith("conversation-1", "Hello!", "user-1");
  });

  it("setConversationChatMode refuses an unowned conversation", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);

    const result = await setConversationChatMode("someone-elses-conversation", "mode-1");

    expect(result).toEqual({ success: false, error: "Conversation not found" });
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });

  it("setConversationChatMode refuses a chat mode owned by a different user (spec §74)", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ id: "conversation-1" });
    prismaMock.chatMode.findFirst.mockResolvedValue(null); // not built-in, not this user's

    const result = await setConversationChatMode("conversation-1", "someone-elses-mode");

    expect(result).toEqual({ success: false, error: "Selected chat mode was not found" });
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
    expect(prismaMock.chatMode.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "someone-elses-mode",
          OR: [{ userId: null }, { userId: "user-1" }],
        },
      }),
    );
  });

  it("setConversationChatMode allows selecting a built-in or the user's own custom mode", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ id: "conversation-1" });
    prismaMock.chatMode.findFirst.mockResolvedValue({ id: "mode-1" });

    const result = await setConversationChatMode("conversation-1", "mode-1");

    expect(result).toEqual({ success: true });
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { chatModeId: "mode-1" },
    });
  });

  it("setConversationChatMode allows clearing the mode (null) without an ownership lookup", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ id: "conversation-1" });

    const result = await setConversationChatMode("conversation-1", null);

    expect(result).toEqual({ success: true });
    expect(prismaMock.chatMode.findFirst).not.toHaveBeenCalled();
  });
});
