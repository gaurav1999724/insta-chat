import { NextResponse } from "next/server";

import { env } from "@/lib/validation/env";

// Shared between the connect and callback route handlers — must match on
// both sides for the CSRF state check to work.
export const INSTAGRAM_OAUTH_STATE_COOKIE = "ig_oauth_state";

export const instagramOAuthStateCookieOptions = {
  httpOnly: true,
  secure: env.NEXTAUTH_URL.startsWith("https://"),
  sameSite: "lax" as const,
  maxAge: 600,
  path: "/",
};

export type InstagramConnectStatus =
  | "connected"
  | "denied"
  | "error"
  | "not_configured"
  | "already_connected"
  | "rate_limited";

export function settingsRedirect(status: InstagramConnectStatus) {
  const url = new URL("/settings", env.NEXTAUTH_URL);
  url.searchParams.set("instagram", status);
  return NextResponse.redirect(url);
}
