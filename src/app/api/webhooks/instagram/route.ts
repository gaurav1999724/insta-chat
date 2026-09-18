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

// Meta's one-time subscription handshake: echo hub.challenge back as plain
// text if hub.mode/hub.verify_token check out (spec §38).
export async function GET(request: Request) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

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

  // Signature verification needs the exact raw bytes Meta signed — read as
  // text first, never request.json() (which would re-serialize and break
  // the comparison).
  const rawBody = await request.text();

  if (!isValidWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    await logWebhookError("Instagram webhook signature verification failed.");
    return new Response("Invalid signature", { status: 403 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    await logWebhookError("Instagram webhook body was not valid JSON.");
    return new Response("OK", { status: 200 });
  }

  const parsed = instagramWebhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    await logWebhookError(
      "Instagram webhook payload failed schema validation.",
      parsed.error.issues,
    );
    return new Response("OK", { status: 200 });
  }

  for (const entry of parsed.data.entry) {
    // Account ownership (spec §38/§74): only process events for Instagram
    // accounts we actually have connected and active.
    const instagramAccount = await prisma.instagramAccount.findUnique({
      where: { instagramUserId: entry.id },
      select: { id: true, status: true, userId: true },
    });

    for (const item of entry.messaging ?? []) {
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
          continue;
        }
        await logWebhookError("Failed to record incoming Instagram webhook event.", {
          externalEventId,
        });
        continue;
      }

      if (!instagramAccount || instagramAccount.status !== "ACTIVE") {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { status: "IGNORED", processedAt: new Date() },
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

      const startedAt = Date.now();
      try {
        const result = await processMessagingItem(instagramAccount.id, item);
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
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

  return new Response("OK", { status: 200 });
}
