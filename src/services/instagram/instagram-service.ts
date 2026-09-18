import { env } from "@/lib/validation/env";
import { InstagramApiError } from "@/lib/instagram/errors";

// Verified against Meta's "Instagram API with Instagram Login" docs
// (developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login)
// on 2026-09-17 — see docs/INSTAGRAM_SETUP.md for sources and details.
// This is the direct Instagram Business Login flow (no Facebook Page
// required), which is what spec §7/§37 calls for.
const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_LIVED_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_HOST = "https://graph.instagram.com";
// Verified 2026-09-17 (see docs/INSTAGRAM_SETUP.md): the OAuth/token
// endpoints on this host (`/access_token`, `/refresh_access_token`) work
// unversioned, but the content/messaging endpoints (`/me`, `/{id}/messages`)
// use the standard `/vNN.N/` path — corrected from an earlier, too-broad
// "this host is unversioned" assumption. Always include the version there.

// Only what Phase 4/5/9 need so far. getConversations()/getMessages()
// (historical sync) aren't implemented — spec §37 lists the full method
// set, added incrementally.
const SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"];

export const INSTAGRAM_CALLBACK_PATH = "/api/instagram/callback";

function requireAppCredentials(): { appId: string; appSecret: string } {
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new InstagramApiError(
      "Instagram connection is not configured on this server.",
      "INSTAGRAM_AUTH_ERROR",
    );
  }

  return { appId: env.META_APP_ID, appSecret: env.META_APP_SECRET };
}

function getRedirectUri(): string {
  return new URL(INSTAGRAM_CALLBACK_PATH, env.NEXTAUTH_URL).toString();
}

export function getAuthorizationUrl(state: string): string {
  const { appId } = requireAppCredentials();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);

  return url.toString();
}

type ShortLivedTokenResult = {
  accessToken: string;
  instagramUserId: string;
  permissions: string[];
};

export async function exchangeCodeForShortLivedToken(
  code: string,
): Promise<ShortLivedTokenResult> {
  const { appId, appSecret } = requireAppCredentials();

  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: getRedirectUri(),
    code,
  });

  const response = await fetch(SHORT_LIVED_TOKEN_URL, { method: "POST", body });
  const json = await response.json().catch(() => null);
  // Instagram Login returns token fields at the top level. Keep accepting
  // the older nested shape for compatibility with existing Meta responses.
  const entry = json?.data?.[0] ?? json;

  if (!response.ok || !entry?.access_token || !entry?.user_id) {
    throw new InstagramApiError(
      "Instagram rejected the authorization code.",
      "INSTAGRAM_AUTH_ERROR",
      json,
    );
  }

  return {
    accessToken: entry.access_token,
    instagramUserId: String(entry.user_id),
    permissions:
      typeof entry.permissions === "string"
        ? entry.permissions.split(",")
        : Array.isArray(entry.permissions)
          ? entry.permissions
          : [],
  };
}

type LongLivedTokenResult = { accessToken: string; expiresInSeconds: number };

export async function exchangeForLongLivedToken(
  shortLivedAccessToken: string,
): Promise<LongLivedTokenResult> {
  const { appSecret } = requireAppCredentials();

  const url = new URL(`${GRAPH_HOST}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token", shortLivedAccessToken);

  const response = await fetch(url);
  const json = await response.json().catch(() => null);

  if (!response.ok || !json?.access_token) {
    throw new InstagramApiError(
      "Failed to exchange the Instagram token for a long-lived one.",
      "INSTAGRAM_AUTH_ERROR",
      json,
    );
  }

  return { accessToken: json.access_token, expiresInSeconds: json.expires_in };
}

// Not called from anywhere yet — no scheduled job exists until Phase 9/12.
// Long-lived tokens last 60 days and can be refreshed once they're at least
// 24 hours old; this is here so that job has something to call.
export async function refreshLongLivedToken(
  longLivedAccessToken: string,
): Promise<LongLivedTokenResult> {
  const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", longLivedAccessToken);

  const response = await fetch(url);
  const json = await response.json().catch(() => null);

  if (!response.ok || !json?.access_token) {
    throw new InstagramApiError(
      "Failed to refresh the Instagram access token.",
      "INSTAGRAM_AUTH_ERROR",
      json,
    );
  }

  return { accessToken: json.access_token, expiresInSeconds: json.expires_in };
}

type InstagramProfile = {
  id: string;
  username: string;
  accountType?: string;
  profilePictureUrl?: string;
};

export async function getProfile(accessToken: string): Promise<InstagramProfile> {
  const url = new URL(`${GRAPH_HOST}/${env.META_GRAPH_API_VERSION}/me`);
  url.searchParams.set("fields", "id,username,account_type,profile_picture_url");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url);
  const json = await response.json().catch(() => null);

  if (!response.ok || !json?.id || !json?.username) {
    throw new InstagramApiError(
      "Failed to load the connected Instagram account's profile.",
      "INSTAGRAM_API_ERROR",
      json,
    );
  }

  return {
    id: String(json.id),
    username: json.username,
    accountType: json.account_type,
    profilePictureUrl: json.profile_picture_url,
  };
}

// spec §22/§59/§37: send a text DM. Callers must check the 24-hour
// messaging window themselves first (see
// `src/lib/instagram/send-eligibility.ts`) — this function does not, and
// never applies the `HUMAN_AGENT` tag to extend that window. That tag is
// Meta's mechanism for a real human replying manually up to 7 days later;
// using it to let *our* automation send outside the window is exactly the
// "bypass a platform limitation through an unofficial/automated path"
// spec §41 forbids, so this app never sends that way (documented in
// docs/INSTAGRAM_SETUP.md).
export type SendMessageResult = { externalMessageId: string };

export async function sendMessage(
  accessToken: string,
  senderInstagramUserId: string,
  recipientInstagramUserId: string,
  text: string,
): Promise<SendMessageResult> {
  const url = `${GRAPH_HOST}/${env.META_GRAPH_API_VERSION}/${senderInstagramUserId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: recipientInstagramUserId },
      message: { text },
    }),
  });

  const json = await response.json().catch(() => null);

  if (!response.ok || !json?.message_id) {
    throw new InstagramApiError(
      "Failed to send the Instagram message.",
      "INSTAGRAM_API_ERROR",
      json,
    );
  }

  return { externalMessageId: String(json.message_id) };
}
