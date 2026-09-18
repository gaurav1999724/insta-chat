import { beforeEach, describe, expect, it, vi } from "vitest";

// The worker only runs when Redis is configured (`getRedisConnection()`
// returns non-null) — `startAIResponseWorker()` constructs a real BullMQ
// `Worker`, which needs a connection object shaped enough not to throw on
// construction. What's actually under test is the async processor function
// passed to `new Worker(...)`, captured via the mock below.
const { WorkerMock, getRedisConnection } = vi.hoisted(() => ({
  WorkerMock: vi.fn(),
  getRedisConnection: vi.fn(),
}));
vi.mock("bullmq", () => ({ Worker: WorkerMock }));
vi.mock("@/lib/queue/connection", () => ({ getRedisConnection }));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    conversation: { findUnique: vi.fn() },
    message: { findFirst: vi.fn() },
    aIResponse: { update: vi.fn() },
  },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { createDraftReply } = vi.hoisted(() => ({ createDraftReply: vi.fn() }));
vi.mock("@/services/ai/draft-service", () => ({ createDraftReply }));

const { getInstagramSendQueue } = vi.hoisted(() => ({ getInstagramSendQueue: vi.fn() }));
vi.mock("@/lib/queue/queues", () => ({
  AI_RESPONSE_QUEUE_NAME: "ai-response",
  getInstagramSendQueue,
}));

const { startAIResponseWorker } = await import("@/lib/queue/workers/ai-response-worker");

async function runProcessor(jobData: { conversationId: string }) {
  const [, processor] = WorkerMock.mock.calls[0];
  return processor({ data: jobData });
}

const eligibleConversation = {
  aiEnabled: true,
  humanTakeover: false,
  status: "ACTIVE",
  instagramAccount: {
    status: "ACTIVE",
    user: { aiConfiguration: { autoSend: true } },
  },
  settings: { autoSend: null },
};

describe("startAIResponseWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedisConnection.mockReturnValue({});
    getInstagramSendQueue.mockReturnValue({ add: vi.fn() });
    startAIResponseWorker();
  });

  it("returns null and never constructs a Worker when Redis isn't configured", () => {
    getRedisConnection.mockReturnValue(null);
    WorkerMock.mockClear();

    const worker = startAIResponseWorker();

    expect(worker).toBeNull();
    expect(WorkerMock).not.toHaveBeenCalled();
  });

  it("does nothing when the conversation no longer exists", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(null);

    await runProcessor({ conversationId: "gone" });

    expect(createDraftReply).not.toHaveBeenCalled();
  });

  it("does nothing when AI has been disabled since the job was enqueued", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...eligibleConversation,
      aiEnabled: false,
    });

    await runProcessor({ conversationId: "conversation-1" });

    expect(createDraftReply).not.toHaveBeenCalled();
  });

  it("does nothing during human takeover, even if AI is still enabled", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...eligibleConversation,
      humanTakeover: true,
    });

    await runProcessor({ conversationId: "conversation-1" });

    expect(createDraftReply).not.toHaveBeenCalled();
  });

  it("generates a draft but leaves it PENDING_APPROVAL when autoSend is off", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({
      ...eligibleConversation,
      instagramAccount: {
        ...eligibleConversation.instagramAccount,
        user: { aiConfiguration: { autoSend: false } },
      },
    });
    createDraftReply.mockResolvedValue({ success: true, aiResponseId: "ai-1" });

    await runProcessor({ conversationId: "conversation-1" });

    expect(createDraftReply).toHaveBeenCalledWith("conversation-1");
    expect(prismaMock.aIResponse.update).not.toHaveBeenCalled();
    expect(getInstagramSendQueue().add).not.toHaveBeenCalled();
  });

  it("approves and enqueues the send when autoSend is on and inside the messaging window", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(eligibleConversation);
    createDraftReply.mockResolvedValue({ success: true, aiResponseId: "ai-1" });
    prismaMock.message.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await runProcessor({ conversationId: "conversation-1" });

    expect(prismaMock.aIResponse.update).toHaveBeenCalledWith({
      where: { id: "ai-1" },
      data: { status: "APPROVED" },
    });
    expect(getInstagramSendQueue().add).toHaveBeenCalledWith("send", {
      aiResponseId: "ai-1",
    });
  });

  it("leaves the draft pending (never sends) when autoSend is on but the window has closed", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(eligibleConversation);
    createDraftReply.mockResolvedValue({ success: true, aiResponseId: "ai-1" });
    prismaMock.message.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    await runProcessor({ conversationId: "conversation-1" });

    expect(prismaMock.aIResponse.update).not.toHaveBeenCalled();
    expect(getInstagramSendQueue().add).not.toHaveBeenCalled();
  });

  it("throws (rather than swallowing) when draft generation fails, so BullMQ retries the job", async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(eligibleConversation);
    createDraftReply.mockResolvedValue({
      success: false,
      error: "Gemini quota exceeded",
    });

    await expect(runProcessor({ conversationId: "conversation-1" })).rejects.toThrow(
      "Gemini quota exceeded",
    );
  });
});
