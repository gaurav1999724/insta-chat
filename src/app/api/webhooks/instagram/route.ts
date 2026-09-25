import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { after } from "next/server";

import { prisma } from "@/lib/db/prisma";
import {
  getMessageEventId,
  isValidWebhookSignature,
  socialApiDmEventSchema,
  socialApiWebhookEnvelopeSchema,
} from "@/lib/instagram/webhook";
import { logOperation } from "@/lib/logging/logger";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { maybeAutoRespond } from "@/services/ai/auto-respond-service";
import { retryDueFailedDeliveriesForConversation } from "@/services/ai/retry-service";
import { processMessagingItem } from "@/services/instagram/webhook-processor";

async function logWebhookError(message: string, details?: unknown) {
  await prisma.aPIError.create({
    data: {
      category: "WEBHOOK_ERROR",
      message,
      metadata:
        details !== undefined
          ? { details: JSON.parse(JSON.stringify(details)) }
          : undefined,
    },
  });
}

function getWebhookShape(value: unknown): unknown {
  if (!value || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return { type: "array", length: value.length };

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, getWebhookShape(entry)]),
  );
}

// SocialAPI.AI has no verification handshake of its own — a plain
// reachability check is enough for manual sanity checks.
export async function GET() {
  return new Response("OK", { status: 200 });
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  const startedAt = Date.now();

  logOperation({ requestId, operation: "instagram_webhook.received", status: "success" });

  // Signature verification needs the exact raw bytes SocialAPI signed —
  // read as text first, never request.json() (which would re-serialize
  // and break the comparison).
  const rawBody = await request.text();

  const timestamp = request.headers.get("x-socialapi-timestamp");
  const signature = request.headers.get("x-socialapi-signature-v2");

  if (!isValidWebhookSignature(rawBody, timestamp, signature)) {
    logOperation({
      requestId,
      operation: "instagram_webhook.signature_validation",
      status: "failure",
      errorCode: signature ? "invalid_signature" : "missing_signature",
      durationMs: Date.now() - startedAt,
    });
    await logWebhookError("Instagram (SocialAPI.AI) webhook signature verification failed.");
    return new Response("Invalid signature", { status: 403 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    logOperation({
      requestId,
      operation: "instagram_webhook.json_parse",
      status: "failure",
      errorCode: "invalid_json",
      durationMs: Date.now() - startedAt,
    });
    await logWebhookError("Instagram (SocialAPI.AI) webhook body was not valid JSON.");
    return new Response("OK", { status: 200 });
  }

  const envelope = socialApiWebhookEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    logOperation({
      requestId,
      operation: "instagram_webhook.schema_validation",
      status: "failure",
      errorCode: `issues_${envelope.error.issues.length}`,
      durationMs: Date.now() - startedAt,
    });
    await logWebhookError("Instagram (SocialAPI.AI) webhook payload failed schema validation.", {
      issues: envelope.error.issues,
      shape: getWebhookShape(json),
    });
    return new Response("OK", { status: 200 });
  }

  logOperation({
    requestId,
    operation: "instagram_webhook.schema_validation",
    status: "success",
    errorCode: `event_${envelope.data.event}`,
  });

  // Only genuinely new inbound DM content is turned into a Message row.
  // `dm.sent` is deliberately excluded too, not just the other event types
  // (delivery receipts, comments, mentions, referrals, postbacks): it's
  // SocialAPI.AI's echo of a message *we* sent, but it reports Meta's raw
  // message id (`platform_id`) — a completely different id than the
  // `sapi_dm_...` id our own send call already recorded the message under
  // (confirmed 2026-09-21 via a real duplicate: the same outbound text
  // showed up twice, once from `sendApprovedDraft()`'s own insert and
  // once from this echo, because the ids never matched for the idempotency
  // check to dedupe against). Every message this app sends is already
  // recorded locally at send time with full delivery tracking, so this
  // echo adds nothing — processing it only risks exactly that duplicate.
  if (envelope.data.event !== "dm.received") {
    logOperation({
      requestId,
      operation: "instagram_webhook.completed",
      status: "success",
      errorCode: `ignored_${envelope.data.event}`,
      durationMs: Date.now() - startedAt,
    });
    return new Response("OK", { status: 200 });
  }

  const parsed = socialApiDmEventSchema.safeParse(json);
  if (!parsed.success) {
    logOperation({
      requestId,
      operation: "instagram_webhook.schema_validation",
      status: "failure",
      errorCode: `dm_issues_${parsed.error.issues.length}`,
      durationMs: Date.now() - startedAt,
    });
    await logWebhookError(
      "Instagram (SocialAPI.AI) dm event payload failed schema validation.",
      { issues: parsed.error.issues, shape: getWebhookShape(json) },
    );
    return new Response("OK", { status: 200 });
  }

  const event = parsed.data;
  const accountId = event.data.account_id;

  // Account ownership (spec §38/§74): only process events for Instagram
  // accounts we actually have connected and active. `instagramUserId`
  // holds SocialAPI.AI's `account_id` for this provider.
  const instagramAccount = await prisma.instagramAccount.findUnique({
    where: { instagramUserId: accountId },
    select: { id: true, status: true, userId: true },
  });

  logOperation({
    requestId,
    userId: instagramAccount?.userId,
    instagramAccountId: instagramAccount?.id,
    operation: "instagram_webhook.account_lookup",
    status: instagramAccount ? "success" : "failure",
    errorCode: instagramAccount
      ? `account_${accountId}_status_${instagramAccount.status}`
      : `account_${accountId}_not_found`,
  });

  if (!instagramAccount || instagramAccount.status !== "ACTIVE") {
    logOperation({
      requestId,
      operation: "instagram_webhook.completed",
      status: "success",
      errorCode: !instagramAccount ? "account_not_found" : "account_inactive",
      durationMs: Date.now() - startedAt,
    });
    return new Response("OK", { status: 200 });
  }

  const externalEventId = getMessageEventId(event);

  let webhookEvent;
  try {
    webhookEvent = await prisma.webhookEvent.create({
      data: { externalEventId, payload: JSON.parse(JSON.stringify(event)) },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Already recorded this exact delivery (spec §28 idempotency).
      logOperation({
        requestId,
        userId: instagramAccount.userId,
        instagramAccountId: instagramAccount.id,
        operation: "instagram_webhook.completed",
        status: "success",
        errorCode: "duplicate_event",
        durationMs: Date.now() - startedAt,
      });
      return new Response("OK", { status: 200 });
    }
    logOperation({
      requestId,
      userId: instagramAccount.userId,
      instagramAccountId: instagramAccount.id,
      operation: "instagram_webhook.event_record",
      status: "failure",
      errorCode: "persist_failed",
      durationMs: Date.now() - startedAt,
    });
    await logWebhookError("Failed to record incoming Instagram webhook event.", {
      externalEventId,
    });
    return new Response("OK", { status: 200 });
  }

  logOperation({
    requestId,
    userId: instagramAccount.userId,
    instagramAccountId: instagramAccount.id,
    operation: "instagram_webhook.event_record",
    status: "success",
  });

  // spec §50: rate limit webhook processing, keyed per Instagram account.
  const webhookRateLimit = await checkRateLimit("WEBHOOK_PROCESSING", instagramAccount.id);
  if (!webhookRateLimit.allowed) {
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "IGNORED",
        error: "Rate limited: too many webhook events for this account.",
        processedAt: new Date(),
      },
    });
    await prisma.aPIError.create({
      data: {
        category: "RATE_LIMIT_ERROR",
        message: "Webhook processing rate limit exceeded.",
        userId: instagramAccount.userId,
        metadata: { externalEventId },
      },
    });
    logOperation({
      requestId,
      userId: instagramAccount.userId,
      instagramAccountId: instagramAccount.id,
      operation: "instagram_webhook.completed",
      status: "failure",
      errorCode: "RATE_LIMIT_ERROR",
      durationMs: Date.now() - startedAt,
    });
    return new Response("OK", { status: 200 });
  }

  try {
    const result = await processMessagingItem(instagramAccount.id, event);
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    logOperation({
      requestId,
      userId: instagramAccount.userId,
      instagramAccountId: instagramAccount.id,
      messageId: result.processed ? result.messageId : undefined,
      operation: "instagram_webhook.completed",
      status: "success",
      errorCode: result.processed ? "processed" : `ignored_${result.reason}`,
      durationMs: Date.now() - startedAt,
    });

    // Auto-send (spec: user asked for a fully hands-off mode — AI
    // generates and delivers a reply with no approval step). Every event
    // reaching this point is already a genuinely new inbound message
    // (`dm.sent` echoes are filtered out earlier — see that comment).
    // Scheduled via `after()` so Gemini generation + the send call never
    // delay this webhook's own response back to SocialAPI.AI.
    if (result.processed) {
      // Opportunistic retry: a reply that previously failed to send gets
      // another chance as soon as this conversation is active again,
      // instead of waiting for the next background sweep
      // (src/instrumentation.ts). Runs before maybeAutoRespond() so an old
      // queued reply doesn't land after a brand-new one for the same
      // message.
      after(() => retryDueFailedDeliveriesForConversation(result.conversationId));
      after(() => maybeAutoRespond(result.conversationId));
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown webhook processing error";
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: "FAILED", error: message },
    });
    await logWebhookError(`Failed to process Instagram message: ${message}`, {
      externalEventId,
    });
    logOperation({
      requestId,
      userId: instagramAccount.userId,
      instagramAccountId: instagramAccount.id,
      operation: "instagram_webhook.completed",
      status: "failure",
      errorCode: "WEBHOOK_ERROR",
      detail: message,
      durationMs: Date.now() - startedAt,
    });
  }

  return new Response("OK", { status: 200 });
}
