import { prisma } from "@/lib/db/prisma";
import { logOperation } from "@/lib/logging/logger";
import { sendApprovedDraft } from "@/services/ai/send-service";
import { SendMessageError } from "@/services/ai/send-errors";

const SWEEP_RETRY_BATCH_LIMIT = 25;

async function retryOne(aiResponseId: string): Promise<boolean> {
  try {
    await sendApprovedDraft(aiResponseId);
    logOperation({
      messageId: aiResponseId,
      operation: "ai.retry_failed_delivery",
      status: "success",
    });
    return true;
  } catch (error) {
    // sendApprovedDraft() already recorded the new FAILED/nextRetryAt state
    // (and logged its own detailed failure) — this is just a breadcrumb
    // tying that failure to a retry attempt specifically, so the log tail
    // shows *why* a delivery is still FAILED after a retry ran, not just
    // that it is.
    logOperation({
      messageId: aiResponseId,
      operation: "ai.retry_failed_delivery",
      status: "failure",
      errorCode: error instanceof SendMessageError ? "RETRY_FAILED" : "UNEXPECTED_RETRY_ERROR",
      detail: error instanceof Error ? error.message : "Unknown retry error.",
    });
    return false;
  }
}

// The safety net that retries a FAILED reply send even when the
// conversation never receives another inbound message to trigger the
// opportunistic path below. Driven by ordinary app traffic instead of a
// scheduled job — see src/services/ai/retry-sweep-scheduler.ts, which calls
// this at most once per interval, piggybacking on whatever webhook or page
// request happens to come in.
export async function retryDueFailedDeliveries(): Promise<{ attempted: number; sent: number }> {
  // A FAILED delivery with nextRetryAt set is one send-service already
  // classified as worth retrying (transient error, attempts <
  // MAX_SEND_ATTEMPTS — see src/lib/instagram/retry-policy.ts). nextRetryAt
  // is null for permanent failures and exhausted retries, so it never
  // matches this query.
  const due = await prisma.messageDelivery.findMany({
    where: { status: "FAILED", nextRetryAt: { lte: new Date() } },
    include: { message: { select: { sentAsResponse: { select: { id: true } } } } },
    orderBy: { nextRetryAt: "asc" },
    take: SWEEP_RETRY_BATCH_LIMIT,
  });

  let sent = 0;
  for (const delivery of due) {
    const aiResponseId = delivery.message.sentAsResponse?.id;
    if (!aiResponseId) continue;
    if (await retryOne(aiResponseId)) sent++;
  }

  return { attempted: due.length, sent };
}

// Called from the webhook route right after a new inbound message is
// processed for a conversation, so a previously-failed reply gets another
// chance to go out as soon as the conversation is active again, rather than
// waiting for the next background sweep (src/instrumentation.ts). Only
// picks up deliveries already due (nextRetryAt in the past) — it does not
// bypass the backoff schedule.
export async function retryDueFailedDeliveriesForConversation(conversationId: string): Promise<void> {
  const due = await prisma.messageDelivery.findMany({
    where: {
      status: "FAILED",
      nextRetryAt: { lte: new Date() },
      message: { conversationId },
    },
    include: { message: { select: { sentAsResponse: { select: { id: true } } } } },
    orderBy: { nextRetryAt: "asc" },
  });

  if (due.length === 0) return;

  let sent = 0;
  for (const delivery of due) {
    const aiResponseId = delivery.message.sentAsResponse?.id;
    if (!aiResponseId) continue;
    if (await retryOne(aiResponseId)) sent++;
  }

  logOperation({
    conversationId,
    operation: "ai.retry_failed_delivery_for_conversation",
    status: "success",
    errorCode: `attempted_${due.length}_sent_${sent}`,
  });
}
