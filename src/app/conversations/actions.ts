"use server";

import { revalidatePath } from "next/cache";
import { EmojiLevel, Language, ResponseLength } from "@prisma/client";
import { z } from "zod";

import { requireUser } from "@/lib/auth/require-user";
import { prisma } from "@/lib/db/prisma";
import { createDraftReply } from "@/services/ai/draft-service";
import { runConversationAnalysis } from "@/services/ai/memory-service";
import {
  SendMessageError,
  sendApprovedDraft,
  sendManualMessage,
} from "@/services/ai/send-service";

export type ActionResult = { success: true } | { success: false; error: string };

// Authorization (spec §74): every mutation here re-verifies the
// conversation belongs, transitively through InstagramAccount, to the
// calling user — never trust an id from the client alone.
async function requireOwnedConversation(userId: string, conversationId: string) {
  return prisma.conversation.findFirst({
    where: { id: conversationId, instagramAccount: { userId } },
    select: { id: true },
  });
}

export async function setConversationAIEnabled(
  conversationId: string,
  aiEnabled: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  await prisma.$transaction([
    prisma.conversation.update({ where: { id: conversationId }, data: { aiEnabled } }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: aiEnabled ? "AI_ENABLED" : "AI_DISABLED",
        entityType: "Conversation",
        entityId: conversationId,
      },
    }),
  ]);

  revalidatePath(`/conversations/${conversationId}`);
  return { success: true };
}

export async function setConversationHumanTakeover(
  conversationId: string,
  humanTakeover: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  await prisma.$transaction([
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        humanTakeover,
        status: humanTakeover ? "HUMAN_TAKEOVER" : "ACTIVE",
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: humanTakeover ? "HUMAN_TAKEOVER_ENABLED" : "HUMAN_TAKEOVER_DISABLED",
        entityType: "Conversation",
        entityId: conversationId,
      },
    }),
  ]);

  revalidatePath(`/conversations/${conversationId}`);
  return { success: true };
}

export async function setConversationChatMode(
  conversationId: string,
  chatModeId: string | null,
): Promise<ActionResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  if (chatModeId) {
    // Only a built-in mode (userId null) or one of this user's own custom
    // modes may be selected — never another user's (spec §74).
    const mode = await prisma.chatMode.findFirst({
      where: { id: chatModeId, OR: [{ userId: null }, { userId: user.id }] },
      select: { id: true },
    });
    if (!mode) return { success: false, error: "Selected chat mode was not found" };
  }

  await prisma.$transaction([
    prisma.conversation.update({ where: { id: conversationId }, data: { chatModeId } }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "MODE_CHANGED",
        entityType: "Conversation",
        entityId: conversationId,
      },
    }),
  ]);

  revalidatePath(`/conversations/${conversationId}`);
  return { success: true };
}

// Quick per-conversation override for the "Auto-send" behavior, exposed
// right above the composer for fast access (the full tri-state
// inherit/on/off control also lives in the AI behavior overrides panel —
// this always writes an explicit `true`/`false`, never `null`/inherit).
// See `maybeAutoRespond()` (src/services/ai/auto-respond-service.ts) for
// what actually happens when this is on: the next inbound message gets an
// AI reply generated *and sent* with no approval step at all.
export async function setConversationAutoSend(
  conversationId: string,
  autoSend: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  await prisma.$transaction([
    prisma.conversationSettings.upsert({
      where: { conversationId },
      update: { autoSend },
      create: { conversationId, autoSend },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "SETTINGS_CHANGED",
        entityType: "Conversation",
        entityId: conversationId,
      },
    }),
  ]);

  revalidatePath(`/conversations/${conversationId}`);
  return { success: true };
}

export type DraftReplyPayload = {
  aiResponseId: string;
  text: string;
  confidence: number;
  provider: "GEMINI" | "OPENAI";
};
export type GenerateDraftReplyResult =
  { success: true; draft: DraftReplyPayload } | { success: false; error: string };

async function persistGeneratedDraft(
  userId: string,
  conversationId: string,
): Promise<GenerateDraftReplyResult> {
  const result = await createDraftReply(conversationId, userId);

  if (!result.success) {
    return result;
  }

  revalidatePath("/dashboard");
  revalidatePath(`/conversations/${conversationId}`);
  return {
    success: true,
    draft: {
      aiResponseId: result.aiResponseId,
      text: result.text,
      confidence: result.confidence,
      provider: result.provider,
    },
  };
}

// Manual, on-demand generation (the composer's "AI Generate" button) —
// deliberately not gated on `aiEnabled`/`humanTakeover`: spec §23 explicitly
// allows the AI to "optionally generate suggestions" even during human
// takeover, it just must never auto-send. Automatic generation off an
// inbound webhook message is the `ai-response` queue worker (Phase 9) —
// both call the same `createDraftReply()` service.
export async function generateDraftReply(
  conversationId: string,
): Promise<GenerateDraftReplyResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  return persistGeneratedDraft(user.id, conversationId);
}

// spec §58: "Edit / Regenerate / Send / Reject". Regenerating supersedes
// the previous draft (marks it REGENERATED) rather than deleting it, so the
// generation history stays in `AIResponse`.
export async function regenerateDraftReply(
  conversationId: string,
  previousAiResponseId: string,
): Promise<GenerateDraftReplyResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  const previous = await prisma.aIResponse.findFirst({
    where: { id: previousAiResponseId, conversationId, status: "PENDING_APPROVAL" },
    select: { id: true },
  });

  const result = await persistGeneratedDraft(user.id, conversationId);

  if (result.success && previous) {
    await prisma.aIResponse.update({
      where: { id: previous.id },
      data: { status: "REGENERATED" },
    });
  }

  return result;
}

async function requireOwnedAIResponse(userId: string, aiResponseId: string) {
  return prisma.aIResponse.findFirst({
    where: { id: aiResponseId, conversation: { instagramAccount: { userId } } },
    select: { id: true, conversationId: true },
  });
}

// spec §58: "Only 'Send' should call Instagram's send API" — Approve just
// marks the draft ready; `sendDraftReply()` below is the one that actually
// calls it. No dedicated AuditAction exists for approve/reject (spec §53's
// audit list doesn't include them), so none is logged here.
export async function approveDraftReply(aiResponseId: string): Promise<ActionResult> {
  const user = await requireUser();
  const aiResponse = await requireOwnedAIResponse(user.id, aiResponseId);
  if (!aiResponse) return { success: false, error: "Draft not found" };

  await prisma.aIResponse.update({
    where: { id: aiResponseId },
    data: { status: "APPROVED" },
  });
  revalidatePath(`/conversations/${aiResponse.conversationId}`);
  return { success: true };
}

export async function rejectDraftReply(aiResponseId: string): Promise<ActionResult> {
  const user = await requireUser();
  const aiResponse = await requireOwnedAIResponse(user.id, aiResponseId);
  if (!aiResponse) return { success: false, error: "Draft not found" };

  await prisma.aIResponse.update({
    where: { id: aiResponseId },
    data: { status: "REJECTED" },
  });
  revalidatePath(`/conversations/${aiResponse.conversationId}`);
  return { success: true };
}

// spec §58/§59/§37: the only action that actually calls Instagram's send
// API (`sendApprovedDraft()` — shared with the automatic `instagram-send`
// queue worker). Refuses outside the 24-hour messaging window rather than
// attempting an unofficial workaround (spec §41).
export async function sendDraftReply(aiResponseId: string): Promise<ActionResult> {
  const user = await requireUser();
  const aiResponse = await requireOwnedAIResponse(user.id, aiResponseId);
  if (!aiResponse) return { success: false, error: "Draft not found" };

  try {
    await sendApprovedDraft(aiResponseId, user.id);
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof SendMessageError ? error.message : "Failed to send the message.",
    };
  }

  revalidatePath("/dashboard");
  revalidatePath(`/conversations/${aiResponse.conversationId}`);
  return { success: true };
}

const manualMessageSchema = z.string().trim().min(1, "Message can't be empty").max(2000);

// spec §61: "Allow: manual typing... send... The user must always be able
// to manually communicate" — this is the one send path never gated on
// `aiEnabled`/`humanTakeover`, only on the same universal Instagram
// constraints (account connected, 24-hour messaging window) every send
// goes through (`sendManualMessage()`).
export async function sendManualMessageAction(
  conversationId: string,
  text: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  const parsed = manualMessageSchema.safeParse(text);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid message",
    };
  }

  try {
    await sendManualMessage(conversationId, parsed.data, user.id);
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof SendMessageError ? error.message : "Failed to send the message.",
    };
  }

  revalidatePath("/dashboard");
  revalidatePath(`/conversations/${conversationId}`);
  return { success: true };
}

const draftTextSchema = z.string().trim().min(1, "Reply can't be empty").max(2000);

export async function updateDraftReplyText(
  aiResponseId: string,
  text: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const aiResponse = await requireOwnedAIResponse(user.id, aiResponseId);
  if (!aiResponse) return { success: false, error: "Draft not found" };

  const parsed = draftTextSchema.safeParse(text);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid text" };
  }

  await prisma.aIResponse.update({
    where: { id: aiResponseId },
    data: { text: parsed.data },
  });
  revalidatePath(`/conversations/${aiResponse.conversationId}`);
  return { success: true };
}

// spec §19 (memory extraction) + §21 (style learning) combined into one
// manual "Analyze conversation" action for a simpler UI — both are still
// distinct GeminiService capabilities underneath
// (`extractMemory`/`analyzeCommunicationStyle`), just orchestrated
// together in `runConversationAnalysis()`, shared with the automatic
// `memory-extraction` queue worker (Phase 9).
export async function analyzeConversation(
  conversationId: string,
): Promise<
  Awaited<ReturnType<typeof runConversationAnalysis>> | { success: false; error: string }
> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false as const, error: "Conversation not found" };

  const result = await runConversationAnalysis(conversationId, user.id);
  revalidatePath(`/conversations/${conversationId}`);
  return result;
}

export async function deleteConversationMemory(memoryId: string): Promise<ActionResult> {
  const user = await requireUser();
  const memory = await prisma.conversationMemory.findFirst({
    where: { id: memoryId, conversation: { instagramAccount: { userId: user.id } } },
    select: { id: true, conversationId: true },
  });
  if (!memory) return { success: false, error: "Memory not found" };

  await prisma.$transaction([
    prisma.conversationMemory.delete({ where: { id: memoryId } }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "MEMORY_CHANGED",
        entityType: "Conversation",
        entityId: memory.conversationId,
      },
    }),
  ]);

  revalidatePath(`/conversations/${memory.conversationId}`);
  return { success: true };
}

// spec §75: "Clear conversation memory."
export async function clearConversationMemory(
  conversationId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  await prisma.$transaction([
    prisma.conversationMemory.deleteMany({ where: { conversationId } }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "MEMORY_CHANGED",
        entityType: "Conversation",
        entityId: conversationId,
      },
    }),
  ]);

  revalidatePath(`/conversations/${conversationId}`);
  return { success: true };
}

const conversationAISettingsSchema = z.object({
  language: z.nativeEnum(Language).nullable(),
  responseLength: z.nativeEnum(ResponseLength).nullable(),
  emojiLevel: z.nativeEnum(EmojiLevel).nullable(),
  memoryEnabled: z.boolean().nullable(),
  autoSend: z.boolean().nullable(),
  customInstructions: z.string().trim().max(2000).nullable(),
});

// spec §57's per-conversation AI-behavior overrides — deferred from Phase 6
// because nothing read them until Phase 7's prompt builder existed. `null`
// on any field means "inherit the user's AIConfiguration" (spec §32).
export async function updateConversationAISettings(
  conversationId: string,
  values: unknown,
): Promise<ActionResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  const parsed = conversationAISettingsSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const data = {
    ...parsed.data,
    customInstructions: parsed.data.customInstructions || null,
  };

  await prisma.$transaction([
    prisma.conversationSettings.upsert({
      where: { conversationId },
      update: data,
      create: { conversationId, ...data },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "SETTINGS_CHANGED",
        entityType: "Conversation",
        entityId: conversationId,
      },
    }),
  ]);

  revalidatePath(`/conversations/${conversationId}`);
  return { success: true };
}

const contactProfileSchema = z.object({
  preferredName: z.string().trim().max(200).optional(),
  relationshipLabel: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(10_000).optional(),
});

export async function updateContactProfile(
  conversationId: string,
  values: unknown,
): Promise<ActionResult> {
  const user = await requireUser();
  const conversation = await requireOwnedConversation(user.id, conversationId);
  if (!conversation) return { success: false, error: "Conversation not found" };

  const parsed = contactProfileSchema.safeParse(values);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const data = {
    preferredName: parsed.data.preferredName || null,
    relationshipLabel: parsed.data.relationshipLabel || null,
    notes: parsed.data.notes || null,
  };

  await prisma.$transaction([
    prisma.conversationSettings.upsert({
      where: { conversationId },
      update: data,
      create: { conversationId, ...data },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "SETTINGS_CHANGED",
        entityType: "Conversation",
        entityId: conversationId,
      },
    }),
  ]);

  revalidatePath(`/conversations/${conversationId}`);
  return { success: true };
}
