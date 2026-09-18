import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InstagramWebhookMessagingItem } from "@/lib/instagram/webhook";

// spec §67: "Instagram webhook → message persistence → conversation lookup
// → AI generation → draft creation → send queue → Instagram API", with
// mocked Meta/Gemini. This environment has no reachable Postgres (see
// PROJECT_ANALYSIS.md §10), so a real database is substituted with a small,
// hand-rolled in-memory fake implementing only the exact Prisma calls the
// three chained services (webhook-processor → draft-service →
// send-service) actually make — not a generic ORM, just enough state to
// prove data flows correctly from one stage to the next and that the
// idempotency guarantee (spec §29) holds across a simulated retry. Each
// service already has its own fully-mocked unit tests; this test's job is
// only to prove the handoffs between them are correct.

type ConversationRecord = {
  id: string;
  instagramAccountId: string;
  externalConversationId: string;
  participantId: string;
  aiEnabled: boolean;
  humanTakeover: boolean;
  status: string;
  lastMessageAt?: Date;
  instagramAccountRecord?: {
    status: string;
    accessTokenEncrypted: string;
    instagramUserId: string;
  };
  participantExternalUserId?: string;
};

type MessageRecord = {
  id: string;
  conversationId: string;
  externalMessageId?: string;
  senderType: string;
  direction: string;
  messageType: string;
  text: string | null;
  externalTimestamp?: Date;
  createdAt: Date;
};

type AIResponseRecord = {
  id: string;
  conversationId: string;
  triggerMessageId?: string;
  text: string;
  confidence: number;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
  status: string;
  sentMessageId?: string;
};

type MessageDeliveryRecord = {
  messageId: string;
  status: string;
  attempts: number;
  lastAttemptAt?: Date;
  errorMessage?: string;
};

type AuditLogRecord = {
  userId?: string;
  action: string;
  entityType: string;
  entityId: string;
};
type AIUsageRecord = {
  conversationId: string;
  aiResponseId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  estimatedCostUsd: number | null;
};
type APIErrorRecord = {
  category: string;
  message: string;
  userId?: string;
  conversationId?: string;
};

interface FakeDb {
  instagramParticipant: {
    upsert: (args: {
      where: {
        instagramAccountId_externalUserId: {
          instagramAccountId: string;
          externalUserId: string;
        };
      };
      create: { instagramAccountId: string; externalUserId: string };
    }) => Promise<{ id: string; instagramAccountId: string; externalUserId: string }>;
  };
  conversation: {
    upsert: (args: {
      where: {
        instagramAccountId_externalConversationId: {
          instagramAccountId: string;
          externalConversationId: string;
        };
      };
      update: Partial<ConversationRecord>;
      create: Omit<ConversationRecord, "id" | "aiEnabled" | "humanTakeover" | "status">;
    }) => Promise<ConversationRecord>;
    findUnique: (args: { where: { id: string } }) => Promise<ConversationRecord | null>;
    update: (args: {
      where: { id: string };
      data: Partial<ConversationRecord>;
    }) => Promise<ConversationRecord>;
  };
  message: {
    upsert: (args: {
      where: { externalMessageId: string };
      update: Partial<MessageRecord>;
      create: Omit<MessageRecord, "id" | "createdAt">;
    }) => Promise<MessageRecord>;
    create: (args: {
      data: Omit<MessageRecord, "id" | "createdAt">;
    }) => Promise<MessageRecord>;
    count: (args: {
      where: { conversationId: string; senderType?: { not: string } };
    }) => Promise<number>;
    findFirst: (args: {
      where: { conversationId: string; direction?: string };
    }) => Promise<MessageRecord | null>;
    update: (args: {
      where: { id: string };
      data: Partial<MessageRecord>;
    }) => Promise<MessageRecord>;
  };
  aIResponse: {
    create: (args: {
      data: Omit<AIResponseRecord, "id" | "status">;
    }) => Promise<AIResponseRecord>;
    update: (args: {
      where: { id: string };
      data: Partial<AIResponseRecord>;
    }) => Promise<AIResponseRecord>;
    findUnique: (args: { where: { id: string } }) => Promise<
      | (AIResponseRecord & {
          conversation: ConversationRecord & {
            instagramAccount: ConversationRecord["instagramAccountRecord"];
            participant: { externalUserId: string | undefined };
          };
        })
      | null
    >;
  };
  aIUsage: { create: (args: { data: AIUsageRecord }) => Promise<AIUsageRecord> };
  auditLog: { create: (args: { data: AuditLogRecord }) => Promise<AuditLogRecord> };
  messageDelivery: {
    upsert: (args: {
      where: { messageId: string };
      update: Partial<MessageDeliveryRecord>;
      create: MessageDeliveryRecord;
    }) => Promise<MessageDeliveryRecord>;
    update: (args: {
      where: { messageId: string };
      data: Partial<MessageDeliveryRecord>;
    }) => Promise<MessageDeliveryRecord>;
  };
  aPIError: { create: (args: { data: APIErrorRecord }) => Promise<APIErrorRecord> };
  $transaction: <T>(arg: Promise<T>[] | ((tx: FakeDb) => Promise<T>)) => Promise<T[] | T>;
  _debug: {
    messages: Map<string, MessageRecord>;
    messageDeliveries: Map<string, MessageDeliveryRecord>;
    auditLogs: AuditLogRecord[];
  };
}

function createFakeDb(): FakeDb {
  const participants = new Map<
    string,
    { id: string; instagramAccountId: string; externalUserId: string }
  >();
  const conversations = new Map<string, ConversationRecord>();
  const conversationsById = new Map<string, ConversationRecord>();
  const messages = new Map<string, MessageRecord>();
  const messagesByExternalId = new Map<string, MessageRecord>();
  const aiResponses = new Map<string, AIResponseRecord>();
  const messageDeliveries = new Map<string, MessageDeliveryRecord>();
  const auditLogs: AuditLogRecord[] = [];
  const aiUsages: AIUsageRecord[] = [];
  const apiErrors: APIErrorRecord[] = [];

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const db: FakeDb = {
    instagramParticipant: {
      upsert: async ({ where, create }) => {
        const key = `${where.instagramAccountId_externalUserId.instagramAccountId}:${where.instagramAccountId_externalUserId.externalUserId}`;
        let record = participants.get(key);
        if (!record) {
          record = { id: nextId("participant"), ...create };
          participants.set(key, record);
        }
        return record;
      },
    },
    conversation: {
      upsert: async ({ where, update, create }) => {
        const key = `${where.instagramAccountId_externalConversationId.instagramAccountId}:${where.instagramAccountId_externalConversationId.externalConversationId}`;
        let record = conversations.get(key);
        if (!record) {
          record = {
            id: nextId("conversation"),
            aiEnabled: true,
            humanTakeover: false,
            status: "ACTIVE",
            ...create,
            // Test-only extras a real InstagramAccount table would hold —
            // attached here so `sendApprovedDraft`'s nested include has
            // something to read, without modeling a whole extra table.
            instagramAccountRecord: {
              status: "ACTIVE",
              accessTokenEncrypted: "ciphertext",
              instagramUserId: "ig-account-1",
            },
            participantExternalUserId: "contact-1",
          };
          conversations.set(key, record);
          conversationsById.set(record.id, record);
        } else {
          Object.assign(record, update);
        }
        return record;
      },
      findUnique: async ({ where }) => conversationsById.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const record = conversationsById.get(where.id);
        if (!record) throw new Error(`fake db: conversation ${where.id} not found`);
        Object.assign(record, data);
        return record;
      },
    },
    message: {
      upsert: async ({ where, update, create }) => {
        let record = messagesByExternalId.get(where.externalMessageId);
        if (!record) {
          // Real Prisma defaults `createdAt` to now() on insert; this fake
          // mirrors that so `assertSendEligible`'s messaging-window check
          // (which reads `createdAt`, not `externalTimestamp`) works.
          record = { id: nextId("message"), createdAt: new Date(), ...create };
          messages.set(record.id, record);
          if (record.externalMessageId) {
            messagesByExternalId.set(record.externalMessageId, record);
          }
        } else {
          Object.assign(record, update);
        }
        return record;
      },
      create: async ({ data }) => {
        const record = { id: nextId("message"), createdAt: new Date(), ...data };
        messages.set(record.id, record);
        if (record.externalMessageId)
          messagesByExternalId.set(record.externalMessageId, record);
        return record;
      },
      count: async ({ where }) =>
        [...messages.values()].filter(
          (m) => m.conversationId === where.conversationId && m.senderType !== "SYSTEM",
        ).length,
      findFirst: async ({ where }) => {
        const list = [...messages.values()]
          .filter(
            (m) =>
              m.conversationId === where.conversationId &&
              (!where.direction || m.direction === where.direction),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return list[0] ?? null;
      },
      update: async ({ where, data }) => {
        const record = messages.get(where.id);
        if (!record) throw new Error(`fake db: message ${where.id} not found`);
        Object.assign(record, data);
        return record;
      },
    },
    aIResponse: {
      create: async ({ data }) => {
        const record: AIResponseRecord = {
          id: nextId("ai-response"),
          status: "PENDING_APPROVAL",
          ...data,
        };
        aiResponses.set(record.id, record);
        return record;
      },
      update: async ({ where, data }) => {
        const record = aiResponses.get(where.id);
        if (!record) throw new Error(`fake db: aiResponse ${where.id} not found`);
        Object.assign(record, data);
        return record;
      },
      findUnique: async ({ where }) => {
        const record = aiResponses.get(where.id);
        if (!record) return null;
        const conversation = conversationsById.get(record.conversationId);
        if (!conversation)
          throw new Error("fake db: conversation missing for aiResponse");
        return {
          ...record,
          conversation: {
            ...conversation,
            instagramAccount: conversation.instagramAccountRecord,
            participant: { externalUserId: conversation.participantExternalUserId },
          },
        };
      },
    },
    aIUsage: {
      create: async ({ data }) => {
        aiUsages.push(data);
        return data;
      },
    },
    auditLog: {
      create: async ({ data }) => {
        auditLogs.push(data);
        return data;
      },
    },
    messageDelivery: {
      upsert: async ({ where, update, create }) => {
        let record = messageDeliveries.get(where.messageId);
        if (!record) {
          record = { ...create };
          messageDeliveries.set(where.messageId, record);
        } else {
          Object.assign(record, update);
        }
        return record;
      },
      update: async ({ where, data }) => {
        const record = messageDeliveries.get(where.messageId);
        if (!record)
          throw new Error(`fake db: messageDelivery ${where.messageId} not found`);
        Object.assign(record, data);
        return record;
      },
    },
    aPIError: {
      create: async ({ data }) => {
        apiErrors.push(data);
        return data;
      },
    },
    $transaction: (async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: FakeDb) => Promise<unknown>)(db)) as FakeDb["$transaction"],
    // Test-only accessors, not part of the real Prisma API surface.
    _debug: { messages, messageDeliveries, auditLogs },
  };

  return db;
}

const fakeDb = vi.hoisted(() => ({ current: null as FakeDb | null }));
vi.mock("@/lib/db/prisma", () => ({
  get prisma() {
    return fakeDb.current;
  },
}));

const { getAIResponseQueue, getMemoryExtractionQueue } = vi.hoisted(() => ({
  getAIResponseQueue: vi.fn(() => null),
  getMemoryExtractionQueue: vi.fn(() => null),
}));
vi.mock("@/lib/queue/queues", () => ({ getAIResponseQueue, getMemoryExtractionQueue }));

const { generateResponse } = vi.hoisted(() => ({ generateResponse: vi.fn() }));
vi.mock("@/services/gemini/gemini-service", () => ({ generateResponse }));

const { checkRateLimit } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/security/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/security/rate-limit")>(
    "@/lib/security/rate-limit",
  );
  return { ...actual, checkRateLimit };
});

vi.mock("@/lib/security/encryption", () => ({ decrypt: vi.fn(() => "decrypted-token") }));

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@/services/instagram/instagram-service", () => ({ sendMessage }));

const { processMessagingItem } = await import("@/services/instagram/webhook-processor");
const { createDraftReply } = await import("@/services/ai/draft-service");
const { sendApprovedDraft } = await import("@/services/ai/send-service");

function inboundItem(
  overrides: Partial<InstagramWebhookMessagingItem> = {},
): InstagramWebhookMessagingItem {
  return {
    sender: { id: "contact-1" },
    recipient: { id: "account-1" },
    timestamp: Date.now(),
    ...overrides,
  } as InstagramWebhookMessagingItem;
}

describe("webhook → persistence → AI draft → send → Instagram (spec §67)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true });
    fakeDb.current = createFakeDb();
  });

  it("carries one inbound message all the way through to an actually-sent Instagram reply", async () => {
    // 1. Instagram webhook delivers an inbound text message.
    const webhookResult = await processMessagingItem(
      "account-1",
      inboundItem({ message: { mid: "mid.inbound-1", text: "Kal milte hain?" } }),
    );
    if (!webhookResult.processed) throw new Error("expected message to be processed");
    const db = fakeDb.current!;

    const conversationId = db._debug.messages.get(
      webhookResult.messageId,
    )?.conversationId;
    expect(conversationId).toBeTruthy();

    // 2. AI generation produces a draft reply (Gemini mocked).
    generateResponse.mockResolvedValue({
      text: "Haan bilkul, kal milte hain!",
      confidence: 0.8,
      model: "gemini-3.8-flash",
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      durationMs: 250,
    });
    const draftResult = await createDraftReply(conversationId as string, "user-1");
    expect(draftResult.success).toBe(true);
    if (!draftResult.success) return;

    // 3. Approve the draft (what the auto-send worker or a manual click does).
    await db.aIResponse.update({
      where: { id: draftResult.aiResponseId },
      data: { status: "APPROVED" },
    });

    // 4. Send it — Instagram's Send API is mocked, never called for real.
    sendMessage.mockResolvedValue({ externalMessageId: "mid.sent.1" });
    const sendResult = await sendApprovedDraft(draftResult.aiResponseId, "user-1");

    expect(sendResult).toEqual({ messageId: expect.any(String) });
    expect(sendMessage).toHaveBeenCalledWith(
      "decrypted-token",
      "ig-account-1",
      "contact-1",
      "Haan bilkul, kal milte hain!",
    );

    const delivery = db._debug.messageDeliveries.get(sendResult.messageId);
    expect(delivery?.status).toBe("SENT");
    expect(db._debug.auditLogs.map((a) => a.action)).toContain("MESSAGE_SENT");
  });

  it("does not create a duplicate outbound message when the send is retried (spec §29 idempotency)", async () => {
    const webhookResult = await processMessagingItem(
      "account-1",
      inboundItem({ message: { mid: "mid.inbound-2", text: "Hey" } }),
    );
    if (!webhookResult.processed) throw new Error("expected message to be processed");
    const conversationId = fakeDb.current!._debug.messages.get(webhookResult.messageId)
      ?.conversationId as string;

    generateResponse.mockResolvedValue({
      text: "Hi there!",
      confidence: 0.7,
      model: "gemini-3.8-flash",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      durationMs: 100,
    });
    const draftResult = await createDraftReply(conversationId, "user-1");
    if (!draftResult.success) throw new Error("expected draft generation to succeed");
    await fakeDb.current!.aIResponse.update({
      where: { id: draftResult.aiResponseId },
      data: { status: "APPROVED" },
    });

    // First attempt fails transiently.
    sendMessage.mockRejectedValueOnce(new Error("network blip"));
    await expect(sendApprovedDraft(draftResult.aiResponseId, "user-1")).rejects.toThrow();

    const messageCountAfterFailure = fakeDb.current!._debug.messages.size;

    // BullMQ retries the exact same job.
    sendMessage.mockResolvedValueOnce({ externalMessageId: "mid.sent.retry" });
    const retryResult = await sendApprovedDraft(draftResult.aiResponseId, "user-1");

    expect(fakeDb.current!._debug.messages.size).toBe(messageCountAfterFailure);
    expect(retryResult.messageId).toBeTruthy();
    expect(
      fakeDb.current!._debug.messageDeliveries.get(retryResult.messageId)?.status,
    ).toBe("SENT");
  });
});
