import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/validation/env";
import {
  getMessagingItemEventId,
  instagramWebhookPayloadSchema,
  isValidVerifyToken,
  isValidWebhookSignature,
} from "@/lib/instagram/webhook";
import { logOperation } from "@/lib/logging/logger";
import { checkRateLimit } from "@/lib/security/rate-limit";
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

// Meta's one-time subscription handshake: echo hub.challenge back as plain
// text if hub.mode/hub.verify_token check out (spec §38).
export async function GET(request: Request) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  logOperation({
    requestId,
    operation: "instagram_webhook_verification.received",
    status: "success",
    errorCode: `mode_${mode ?? "missing"}_token_${token ? "present" : "missing"}_challenge_${challenge ? "present" : "missing"}`,
  });

  if (isValidVerifyToken(mode, token) && challenge) {
    logOperation({
      requestId,
      operation: "instagram_webhook_verification",
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return new Response(challenge, { status: 200 });
  }

  const errorCode = !mode
    ? "missing_mode"
    : mode !== "subscribe"
      ? "invalid_mode"
      : !token
        ? "missing_verify_token"
        : !env.META_WEBHOOK_VERIFY_TOKEN
          ? "server_verify_token_missing"
          : token !== env.META_WEBHOOK_VERIFY_TOKEN
            ? "verify_token_mismatch"
            : !challenge
              ? "missing_challenge"
              : "invalid_verification_request";

  logOperation({
    requestId,
    operation: "instagram_webhook_verification",
    status: "failure",
    errorCode,
    durationMs: Date.now() - startedAt,
  });

  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  // spec §52: structured logging — every operation this request performs
  // is tagged with the same requestId, so a log aggregator can group them.
  const requestId = randomUUID();
  const startedAt = Date.now();
  let eventCount = 0;
  let processedCount = 0;
  let ignoredCount = 0;
  let failedCount = 0;

  logOperation({
    requestId,
    operation: "instagram_webhook.received",
    status: "success",
  });

  // Signature verification needs the exact raw bytes Meta signed — read as
  // text first, never request.json() (which would re-serialize and break
  // the comparison).
  const rawBody = await request.text();

  logOperation({
    requestId,
    operation: "instagram_webhook.body_read",
    status: "success",
    errorCode: `bytes_${Buffer.byteLength(rawBody, "utf8")}`,
  });

  if (!isValidWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    logOperation({
      requestId,
      operation: "instagram_webhook.signature_validation",
      status: "failure",
      errorCode: request.headers.has("x-hub-signature-256")
        ? "invalid_signature"
        : "missing_signature",
      durationMs: Date.now() - startedAt,
    });
    await logWebhookError("Instagram webhook signature verification failed.");
    return new Response("Invalid signature", { status: 403 });
  }

  logOperation({
    requestId,
    operation: "instagram_webhook.signature_validation",
    status: "success",
  });

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
    await logWebhookError("Instagram webhook body was not valid JSON.");
    return new Response("OK", { status: 200 });
  }

  logOperation({
    requestId,
    operation: "instagram_webhook.json_parse",
    status: "success",
  });

  const parsed = instagramWebhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    logOperation({
      requestId,
      operation: "instagram_webhook.schema_validation",
      status: "failure",
      errorCode: `issues_${parsed.error.issues.length}`,
      durationMs: Date.now() - startedAt,
    });
    await logWebhookError(
      "Instagram webhook payload failed schema validation.",
      {
        issues: parsed.error.issues,
        shape: getWebhookShape(json),
      },
    );
    return new Response("OK", { status: 200 });
  }

  eventCount = parsed.data.entry.reduce(
    (count, entry) => count + (entry.messaging?.length ?? 0),
    0,
  );
  logOperation({
    requestId,
    operation: "instagram_webhook.schema_validation",
    status: "success",
    errorCode: `entries_${parsed.data.entry.length}_events_${eventCount}`,
  });

  for (const entry of parsed.data.entry) {
    const entryEventCount = entry.messaging?.length ?? 0;

    if (entryEventCount === 0) {
      logOperation({
        requestId,
        operation: "instagram_webhook.entry",
        status: "success",
        errorCode: `entry_${entry.id}_no_messaging_events`,
      });
      continue;
    }

    // Account ownership (spec §38/§74): only process events for Instagram
    // accounts we actually have connected and active.
    const instagramAccount = await prisma.instagramAccount.findUnique({
      where: { instagramUserId: entry.id },
      select: { id: true, status: true, userId: true },
    });

    logOperation({
      requestId,
      userId: instagramAccount?.userId,
      instagramAccountId: instagramAccount?.id,
      operation: "instagram_webhook.account_lookup",
      status: instagramAccount ? "success" : "failure",
      errorCode: instagramAccount
        ? instagramAccount.status === "ACTIVE"
          ? `entry_${entry.id}_active`
          : `entry_${entry.id}_status_${instagramAccount.status}`
        : `entry_${entry.id}_account_not_found`,
    });

    for (const item of entry.messaging ?? []) {
      if (!item.sender || !item.recipient) {
        ignoredCount += 1;
        logOperation({
          requestId,
          userId: instagramAccount?.userId,
          instagramAccountId: instagramAccount?.id,
          operation: "instagram_webhook.event_process",
          status: "success",
          errorCode: "unsupported_notification_shape",
        });
        continue;
      }

      const externalEventId = getMessagingItemEventId(entry.id, item);

      let webhookEvent;
      try {
        webhookEvent = await prisma.webhookEvent.create({
          data: {
            externalEventId,
            payload: JSON.parse(JSON.stringify(item)),
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          // Already recorded this exact delivery — Meta redelivers on
          // timeout/non-2xx (spec §28 idempotency).
          ignoredCount += 1;
          logOperation({
            requestId,
            userId: instagramAccount?.userId,
            instagramAccountId: instagramAccount?.id,
            operation: "instagram_webhook.event_record",
            status: "success",
            errorCode: "duplicate_event",
          });
          continue;
        }
        failedCount += 1;
        logOperation({
          requestId,
          userId: instagramAccount?.userId,
          instagramAccountId: instagramAccount?.id,
          operation: "instagram_webhook.event_record",
          status: "failure",
          errorCode: "persist_failed",
        });
        await logWebhookError("Failed to record incoming Instagram webhook event.", {
          externalEventId,
        });
        continue;
      }

      logOperation({
        requestId,
        userId: instagramAccount?.userId,
        instagramAccountId: instagramAccount?.id,
        operation: "instagram_webhook.event_record",
        status: "success",
      });

      if (!instagramAccount || instagramAccount.status !== "ACTIVE") {
        ignoredCount += 1;
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { status: "IGNORED", processedAt: new Date() },
        });
        logOperation({
          requestId,
          userId: instagramAccount?.userId,
          instagramAccountId: instagramAccount?.id,
          operation: "instagram_webhook.event_process",
          status: "success",
          errorCode: !instagramAccount ? "account_not_found" : "account_inactive",
        });
        continue;
      }

      // spec §50: rate limit webhook processing, keyed per Instagram
      // account (not per request — Meta can batch many messaging items
      // into one delivery). The event is already durably recorded above
      // for idempotency; being rate-limited just means it's acknowledged
      // without being turned into a Message this cycle, not silently lost.
      const webhookRateLimit = await checkRateLimit(
        "WEBHOOK_PROCESSING",
        instagramAccount.id,
      );
      if (!webhookRateLimit.allowed) {
        ignoredCount += 1;
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
          operation: "webhook.process_message",
          status: "failure",
          errorCode: "RATE_LIMIT_ERROR",
        });
        continue;
      }

      logOperation({
        requestId,
        userId: instagramAccount.userId,
        instagramAccountId: instagramAccount.id,
        operation: "instagram_webhook.rate_limit",
        status: "success",
      });

      const startedAt = Date.now();
      try {
        const result = await processMessagingItem(instagramAccount.id, item);
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
        if (result.processed) processedCount += 1;
        else ignoredCount += 1;
        logOperation({
          requestId,
          userId: instagramAccount.userId,
          instagramAccountId: instagramAccount.id,
          messageId: result.processed ? result.messageId : undefined,
          operation: "webhook.process_message",
          status: "success",
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        failedCount += 1;
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
          operation: "webhook.process_message",
          status: "failure",
          errorCode: "WEBHOOK_ERROR",
          durationMs: Date.now() - startedAt,
        });
      }
    }
  }

  logOperation({
    requestId,
    operation: "instagram_webhook.completed",
    status: failedCount > 0 ? "failure" : "success",
    errorCode: `events_${eventCount}_processed_${processedCount}_ignored_${ignoredCount}_failed_${failedCount}`,
    durationMs: Date.now() - startedAt,
  });

  return new Response("OK", { status: 200 });
}
