import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { instagramAccount: { findMany: vi.fn() } },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { maybeAutoRespond } = vi.hoisted(() => ({ maybeAutoRespond: vi.fn() }));
vi.mock("@/services/ai/auto-respond-service", () => ({ maybeAutoRespond }));

const { recoverUnansweredReplies } = await import(
  "@/services/ai/unanswered-reply-recovery-service"
);

function conversation(id: string, message?: { id: string; direction: string }) {
  return {
    id,
    aiEnabled: true,
    humanTakeover: false,
    messages: message ? [message] : [],
  };
}

describe("recoverUnansweredReplies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeAutoRespond.mockResolvedValue(undefined);
  });

  it("processes only latest inbound messages from the five newest conversations", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([
      {
        conversations: [
          conversation("conversation-1", { id: "message-1", direction: "INBOUND" }),
          conversation("conversation-2", { id: "message-2", direction: "OUTBOUND" }),
          conversation("conversation-3", { id: "message-3", direction: "INBOUND" }),
          conversation("conversation-4"),
          conversation("conversation-5", { id: "message-5", direction: "INBOUND" }),
          conversation("conversation-6", { id: "message-6", direction: "INBOUND" }),
        ].slice(0, 5),
      },
    ]);

    const result = await recoverUnansweredReplies();

    expect(result).toEqual({ accounts: 1, candidates: 3, processed: 3, failed: 0 });
    expect(maybeAutoRespond).toHaveBeenCalledTimes(3);
    expect(maybeAutoRespond).toHaveBeenCalledWith("conversation-1", {
      ignoreAutoSendSetting: true,
      expectedTriggerMessageId: "message-1",
    });
    expect(maybeAutoRespond).toHaveBeenCalledWith("conversation-3", {
      ignoreAutoSendSetting: true,
      expectedTriggerMessageId: "message-3",
    });
    expect(maybeAutoRespond).toHaveBeenCalledWith("conversation-5", {
      ignoreAutoSendSetting: true,
      expectedTriggerMessageId: "message-5",
    });
  });

  it("continues processing other conversations when one recovery fails", async () => {
    prismaMock.instagramAccount.findMany.mockResolvedValue([
      {
        conversations: [
          conversation("conversation-1", { id: "message-1", direction: "INBOUND" }),
          conversation("conversation-2", { id: "message-2", direction: "INBOUND" }),
        ],
      },
    ]);
    maybeAutoRespond.mockRejectedValueOnce(new Error("send failed"));

    const result = await recoverUnansweredReplies();

    expect(result).toEqual({ accounts: 1, candidates: 2, processed: 1, failed: 1 });
    expect(maybeAutoRespond).toHaveBeenCalledTimes(2);
  });
});