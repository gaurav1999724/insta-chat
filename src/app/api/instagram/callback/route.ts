import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import type { ErrorCategory, Prisma } from "@prisma/client";

import { requireUser } from "@/lib/auth/require-user";
import { prisma } from "@/lib/db/prisma";
import { InstagramApiError } from "@/lib/instagram/errors";
import { logOperation } from "@/lib/logging/logger";
import { INSTAGRAM_OAUTH_STATE_COOKIE, settingsRedirect } from "@/lib/instagram/oauth";
import { exchangeOAuthCode } from "@/services/instagram/instagram-service";

function redactInstagramDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactInstagramDetails);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /access_token|client_secret|authorization|^code$/i.test(key)
          ? "[REDACTED]"
          : redactInstagramDetails(entry),
      ]),
    );
  }

  return value;
}

async function logInstagramError(
  userId: string,
  message: string,
  category: ErrorCategory,
  details?: unknown,
) {
  await prisma.aPIError.create({
    data: {
      category,
      message,
      userId,
      // Round-trip through JSON so only plain, serializable data is stored.
      metadata:
        details !== undefined
          ? {
              details: JSON.parse(
                JSON.stringify(redactInstagramDetails(details)),
              ) as Prisma.InputJsonValue,
            }
          : undefined,
    },
  });
}

export async function GET(request: Request) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const user = await requireUser();

  const { searchParams } = new URL(request.url);
  const oauthError = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(INSTAGRAM_OAUTH_STATE_COOKIE)?.value;
  cookieStore.delete(INSTAGRAM_OAUTH_STATE_COOKIE);

  if (oauthError) {
    // User declined consent on Instagram's side — not an application error.
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_oauth_callback",
      status: "success",
      errorCode: "oauth_denied",
      durationMs: Date.now() - startedAt,
    });
    return settingsRedirect("denied");
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_oauth_callback",
      status: "failure",
      errorCode: !expectedState
        ? "missing_state_cookie"
        : !code
          ? "missing_code"
          : !state
            ? "missing_state"
            : "state_mismatch",
      durationMs: Date.now() - startedAt,
    });
    await logInstagramError(
      user.id,
      "Instagram OAuth callback was missing a valid code/state pair.",
      "INSTAGRAM_AUTH_ERROR",
    );
    return settingsRedirect("error");
  }

  try {
    const exchanged = await exchangeOAuthCode(code, state);
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_oauth_exchange",
      status: "success",
    });

    const existing = await prisma.instagramAccount.findUnique({
      where: { instagramUserId: exchanged.accountId },
      select: { userId: true },
    });

    if (existing && existing.userId !== user.id) {
      await logInstagramError(
        user.id,
        `Instagram account @${exchanged.username} is already connected to a different InstaMate account.`,
        "INSTAGRAM_AUTH_ERROR",
      );
      return settingsRedirect("already_connected");
    }

    const shared = {
      userId: user.id,
      username: exchanged.username,
      displayName: exchanged.displayName,
      status: "ACTIVE" as const,
    };

    const account = await prisma.instagramAccount.upsert({
      where: { instagramUserId: exchanged.accountId },
      update: shared,
      create: { instagramUserId: exchanged.accountId, ...shared },
    });
    logOperation({
      requestId,
      userId: user.id,
      instagramAccountId: account.id,
      operation: "instagram_account_persist",
      status: "success",
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "ACCOUNT_CONNECTED",
        entityType: "InstagramAccount",
        entityId: account.id,
      },
    });

    logOperation({
      requestId,
      userId: user.id,
      instagramAccountId: account.id,
      operation: "instagram_oauth_callback",
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return settingsRedirect("connected");
  } catch (error) {
    const message =
      error instanceof InstagramApiError
        ? error.message
        : "Unexpected error connecting the Instagram account.";
    const category =
      error instanceof InstagramApiError ? error.category : "INSTAGRAM_API_ERROR";
    const details = error instanceof InstagramApiError ? error.details : undefined;

    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_oauth_callback",
      status: "failure",
      errorCode: category,
      durationMs: Date.now() - startedAt,
    });
    await logInstagramError(user.id, message, category, details);
    return settingsRedirect("error");
  }
}
