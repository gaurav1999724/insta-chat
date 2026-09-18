import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/require-user";
import { InstagramApiError } from "@/lib/instagram/errors";
import {
  INSTAGRAM_OAUTH_STATE_COOKIE,
  instagramOAuthStateCookieOptions,
  settingsRedirect,
} from "@/lib/instagram/oauth";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { getAuthorizationUrl } from "@/services/instagram/instagram-service";

// Plain browser navigation (an <a href> in Settings), not a fetch/mutation —
// GET is the correct method for a redirect the user's browser follows.
export async function GET() {
  const user = await requireUser();

  // spec §50: rate limit this API endpoint. Keyed by userId (this route
  // requires a session already), not client IP — an IP-based key would
  // need to trust `X-Forwarded-For`, which isn't safe without a known,
  // configured reverse proxy in front of this app.
  const rateLimit = await checkRateLimit("INSTAGRAM_CONNECT", user.id);
  if (!rateLimit.allowed) {
    return settingsRedirect("rate_limited");
  }

  try {
    const state = crypto.randomBytes(16).toString("hex");
    const response = NextResponse.redirect(getAuthorizationUrl(state));
    response.cookies.set(
      INSTAGRAM_OAUTH_STATE_COOKIE,
      state,
      instagramOAuthStateCookieOptions,
    );
    return response;
  } catch (error) {
    if (error instanceof InstagramApiError) {
      return settingsRedirect("not_configured");
    }
    throw error;
  }
}
