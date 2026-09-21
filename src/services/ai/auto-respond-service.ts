import { prisma } from "@/lib/db/prisma";
import { logOperation } from "@/lib/logging/logger";
import { createDraftReply } from "@/services/ai/draft-service";
import { sendApprovedDraft } from "@/services/ai/send-service";

// "Auto-send": when enabled, an inbound message gets an AI reply generated
// *and delivered* immediately, skipping the PENDING_APPROVAL → Approve →
// Send flow the composer normally requires (spec: user explicitly asked
// for "no permission asked" once this is on). Called from the webhook
// route (via `after()`, so it never delays the webhook's own response)
// right after a genuinely new inbound `dm.received` message is persisted.
//
// Effective setting: `ConversationSettings.autoSend` (per-conversation
// override) wins when set; `null` falls back to the user's
// `AIConfiguration.autoSend` global default — same inherit semantics
// every other per-conversation AI override already uses.
export async function maybeAutoRespond(conversationId: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      aiEnabled: true,
      humanTakeover: true,
      settings: { select: { autoSend: true } },
      instagramAccount: { select: { userId: true } },
    },
  });

  if (!conversation || !conversation.aiEnabled || conversation.humanTakeover) return;

  let autoSendEnabled = conversation.settings?.autoSend ?? null;
  if (autoSendEnabled === null) {
    const aiConfig = await prisma.aIConfiguration.findUnique({
      where: { userId: conversation.instagramAccount.userId },
      select: { autoSend: true },
    });
    autoSendEnabled = aiConfig?.autoSend ?? false;
  }
  if (!autoSendEnabled) return;

  // createDraftReply() already logs/records its own failures (GEMINI_ERROR,
  // rate limiting) — nothing more to do here if generation itself failed.
  const draft = await createDraftReply(conversationId);
  if (!draft.success) return;

  try {
    // Skip PENDING_APPROVAL entirely — auto-send means no human gate.
    await prisma.aIResponse.update({
      where: { id: draft.aiResponseId },
      data: { status: "APPROVED" },
    });
    await sendApprovedDraft(draft.aiResponseId);
    logOperation({
      conversationId,
      messageId: draft.aiResponseId,
      operation: "ai.auto_respond",
      status: "success",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown auto-send error";
    logOperation({
      conversationId,
      messageId: draft.aiResponseId,
      operation: "ai.auto_respond",
      status: "failure",
      errorCode: "AUTO_SEND_ERROR",
    });
    // sendApprovedDraft() already records its own APIError/MessageDelivery
    // failure state — this is just an extra breadcrumb tying it to the
    // auto-respond path specifically, never surfaced to a user directly
    // since there's no human waiting on this flow to see it.
    await prisma.aPIError.create({
      data: {
        category: "INSTAGRAM_API_ERROR",
        message: `Auto-send failed: ${message}`,
        conversationId,
      },
    });
  }
}
