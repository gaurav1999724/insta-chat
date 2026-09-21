import crypto, { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { prisma } from "@/lib/db/prisma";
import { InstagramApiError } from "@/lib/instagram/errors";
import {
  INSTAGRAM_OAUTH_STATE_COOKIE,
  instagramOAuthStateCookieOptions,
  settingsRedirect,
} from "@/lib/instagram/oauth";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { logOperation } from "@/lib/logging/logger";
import { env } from "@/lib/validation/env";
import { getConnectAuthUrl } from "@/services/instagram/instagram-service";

// Plain browser navigation (an <a href> in Settings), not a fetch/mutation —
// GET is the correct method for a redirect the user's browser follows.
export async function GET() {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const user = await requireUser();

  // spec §50: rate limit this API endpoint. Keyed by userId (this route
  // requires a session already), not client IP — an IP-based key would
  // need to trust `X-Forwarded-For`, which isn't safe without a known,
  // configured reverse proxy in front of this app.
  const rateLimit = await checkRateLimit("INSTAGRAM_CONNECT", user.id);
  if (!rateLimit.allowed) {
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_connect",
      status: "failure",
      errorCode: "rate_limited",
      durationMs: Date.now() - startedAt,
    });
    return settingsRedirect("rate_limited");
  }

  if (!env.SOCIALAPI_TOKEN) {
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_connect",
      status: "failure",
      errorCode: "not_configured",
      durationMs: Date.now() - startedAt,
    });
    return settingsRedirect("not_configured");
  }

  try {
    const state = crypto.randomBytes(16).toString("hex");
    const result = await getConnectAuthUrl(state);
    if (result.kind !== "auth_url") {
      // Instagram always returns the OAuth-redirect shape — SocialAPI's
      // "direct" (no-redirect) shape is for other platform types, so this
      // would only happen if that ever changed on their side.
      throw new InstagramApiError(
        "Instagram connection did not return an OAuth redirect as expected.",
        "INSTAGRAM_AUTH_ERROR",
      );
    }
    const response = NextResponse.redirect(result.authUrl);
    // Store whatever state SocialAPI.AI actually echoes back (`result.state`),
    // not the value we originally sent (`state`) — its `/accounts/connect`
    // response can return a different opaque state than what was submitted
    // (confirmed 2026-09-21: this mismatch caused every real connect
    // attempt to fail the callback's code/state check with a state that
    // could never match, even on a legitimate, unmodified round-trip).
    response.cookies.set(
      INSTAGRAM_OAUTH_STATE_COOKIE,
      result.state,
      instagramOAuthStateCookieOptions,
    );
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_connect",
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    const errorCode = error instanceof InstagramApiError ? error.category : "unexpected_error";
    logOperation({
      requestId,
      userId: user.id,
      operation: "instagram_connect",
      status: "failure",
      errorCode,
      durationMs: Date.now() - startedAt,
    });
    if (error instanceof InstagramApiError) {
      await prisma.aPIError.create({
        data: { category: error.category, message: error.message, userId: user.id },
      });
      return settingsRedirect("error");
    }
    throw error;
  }
}
