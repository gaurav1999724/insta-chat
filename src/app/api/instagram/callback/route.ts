import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import type { ErrorCategory } from "@prisma/client";

import { requireUser } from "@/lib/auth/require-user";
import { prisma } from "@/lib/db/prisma";
import { encrypt } from "@/lib/security/encryption";
import { InstagramApiError } from "@/lib/instagram/errors";
import { logOperation } from "@/lib/logging/logger";
import { INSTAGRAM_OAUTH_STATE_COOKIE, settingsRedirect } from "@/lib/instagram/oauth";
import {
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  getProfile,
} from "@/services/instagram/instagram-service";

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
          ? { details: JSON.parse(JSON.stringify(details)) }
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

  let stage = "short_lived_token_exchange";

  try {
    const shortLived = await exchangeCodeForShortLivedToken(code);
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_token_exchange_short_lived",
      status: "success",
    });
    stage = "long_lived_token_exchange";
    const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_token_exchange_long_lived",
      status: "success",
    });
    stage = "profile_fetch";
    const profile = await getProfile(longLived.accessToken);
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_profile_fetch",
      status: "success",
    });

    stage = "account_lookup";
    const existing = await prisma.instagramAccount.findUnique({
      where: { instagramUserId: profile.id },
      select: { userId: true },
    });

    if (existing && existing.userId !== user.id) {
      await logInstagramError(
        user.id,
        `Instagram account @${profile.username} is already connected to a different InstaMate account.`,
        "INSTAGRAM_AUTH_ERROR",
      );
      return settingsRedirect("already_connected");
    }

    stage = "account_persist";
    const tokenExpiresAt = new Date(Date.now() + longLived.expiresInSeconds * 1000);
    const shared = {
      userId: user.id,
      username: profile.username,
      profilePictureUrl: profile.profilePictureUrl,
      accessTokenEncrypted: encrypt(longLived.accessToken),
      tokenExpiresAt,
      status: "ACTIVE" as const,
      metadata: profile.accountType ? { accountType: profile.accountType } : undefined,
    };

    const account = await prisma.instagramAccount.upsert({
      where: { instagramUserId: profile.id },
      update: shared,
      create: { instagramUserId: profile.id, ...shared },
    });
    logOperation({
      requestId,
      userId: user.id,
      instagramAccountId: account.id,
      operation: "instagram_account_persist",
      status: "success",
    });

    stage = "audit_log_persist";
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
      errorCode: `${stage}:${category}`,
      durationMs: Date.now() - startedAt,
    });
    await logInstagramError(user.id, message, category, details);
    return settingsRedirect("error");
  }
}
