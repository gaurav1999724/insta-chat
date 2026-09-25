import { env } from "@/lib/validation/env";
import { InstagramApiError } from "@/lib/instagram/errors";
import { logOperation } from "@/lib/logging/logger";

// Switched from direct Meta Graph API access to SocialAPI.AI
// (docs.social-api.ai) on 2026-09-21 — SocialAPI.AI is a third-party
// aggregator, not an official Meta partnership, but it drives the
// connection through a real Meta OAuth consent screen using its own
// "managed" developer app (no Meta Developer App/App Review needed on our
// side) rather than harvesting the account's username/password like the
// briefly-tried CollectAPI integration did. The actual Meta OAuth token
// lives entirely on SocialAPI.AI's infrastructure; we only ever hold their
// opaque `account_id`.
const BASE_URL = "https://api.social-api.ai/v1";

export const INSTAGRAM_CALLBACK_PATH = "/api/instagram/callback";

function requireToken(): string {
  if (!env.SOCIALAPI_TOKEN) {
    throw new InstagramApiError(
      "Instagram connection is not configured on this server.",
      "INSTAGRAM_AUTH_ERROR",
    );
  }
  return env.SOCIALAPI_TOKEN;
}

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${requireToken()}`,
    "Content-Type": "application/json",
  };
}

function getRedirectUri(): string {
  return new URL(INSTAGRAM_CALLBACK_PATH, env.NEXTAUTH_URL).toString();
}

function diagnosticDetails(response: Response, body: unknown) {
  return { httpStatus: response.status, httpStatusText: response.statusText, body };
}

// Every SocialAPI.AI request/response gets logged. Unlike CollectAPI's
// `addInstagram`, none of these request bodies carry a raw password —
// OAuth codes/tokens are opaque, short-lived, and specific to one
// exchange, but redact them anyway as defense in depth.
function redactSocialApiPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSocialApiPayload);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^code$/i.test(key) ? "[REDACTED]" : redactSocialApiPayload(entry),
      ]),
    );
  }

  return value;
}

async function callSocialApi(
  operation: string,
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: Record<string, unknown> } = {},
): Promise<{ response: Response; json: unknown }> {
  const method = init.method ?? "GET";

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: authHeaders(),
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await response.json().catch(() => null);

  logOperation({
    operation: `socialapi.${operation}`,
    status: response.ok ? "success" : "failure",
    errorCode: response.ok ? undefined : `http_${response.status}`,
    requestBody: {
      method,
      url: `${BASE_URL}${path}`,
      body: init.body ? redactSocialApiPayload(init.body) : undefined,
    },
    responseBody: redactSocialApiPayload(json),
  });

  return { response, json };
}

type ConnectResult =
  | { kind: "auth_url"; authUrl: string; state: string }
  | { kind: "connected"; accountId: string; username: string; displayName?: string };

// `POST /accounts/connect` — for Instagram this always returns the 202
// "auth_url" shape (the 201 "direct" shape is for platforms that don't
// need an OAuth redirect, e.g. an API-key-based connection). Redirect the
// user's browser to `authUrl`; SocialAPI's own managed app completes the
// real Meta OAuth consent, then redirects back to `redirectUri` (our own
// callback route) with a `code`/`state` pair for `exchangeOAuthCode()`.
export async function getConnectAuthUrl(state: string): Promise<ConnectResult> {
  const { response, json } = await callSocialApi("accounts.connect", "/accounts/connect", {
    method: "POST",
    body: { platform: "instagram", redirect_uri: getRedirectUri(), state },
  });
  const body = json as
    | { auth_url?: string; state?: string; account_id?: string; username?: string; display_name?: string }
    | null;

  if (response.status === 202 && body?.auth_url) {
    return { kind: "auth_url", authUrl: body.auth_url, state: body.state ?? state };
  }
  if (response.status === 201 && body?.account_id && body?.username) {
    return {
      kind: "connected",
      accountId: body.account_id,
      username: body.username,
      displayName: body.display_name,
    };
  }

  throw new InstagramApiError(
    "Failed to start the Instagram connection.",
    "INSTAGRAM_AUTH_ERROR",
    diagnosticDetails(response, json),
  );
}

type ExchangeResult = { accountId: string; username: string; displayName?: string };

// `POST /oauth/exchange` — finalizes the connection SocialAPI.AI's managed
// app negotiated with Meta, attaching it to our workspace. `code`/`state`
// are whatever Instagram's redirect handed back to our callback route;
// `redirect_uri` must exactly match what `getConnectAuthUrl()` sent.
export async function exchangeOAuthCode(
  code: string,
  state: string,
): Promise<ExchangeResult> {
  const { response, json } = await callSocialApi("oauth.exchange", "/oauth/exchange", {
    method: "POST",
    body: {
      code,
      platform: "instagram",
      metadata: { redirect_uri: getRedirectUri(), state },
    },
  });
  const body = json as
    | { account_id?: string; username?: string; display_name?: string; status?: string }
    | null;

  if (response.status === 201 && body?.account_id && body?.username) {
    return { accountId: body.account_id, username: body.username, displayName: body.display_name };
  }
  if (body?.status === "selection_required") {
    // Multi-account platforms (Google, Facebook Pages) can require picking
    // one of several returned accounts — not a shape Instagram produces,
    // but handled explicitly rather than silently mismatching below.
    throw new InstagramApiError(
      "This Instagram connection returned multiple accounts to choose from, which isn't supported yet.",
      "INSTAGRAM_AUTH_ERROR",
      diagnosticDetails(response, json),
    );
  }

  throw new InstagramApiError(
    "Instagram rejected the connection attempt.",
    "INSTAGRAM_AUTH_ERROR",
    diagnosticDetails(response, json),
  );
}

export type SendMessageResult = { externalMessageId: string };

// `POST /inbox/conversations/{conversationId}/messages` — spec §22/§59/§37:
// send a text DM. Callers must check the 24-hour messaging window
// themselves first (see `src/lib/instagram/send-eligibility.ts`) — this
// function does not, and never attaches a `message_tag` to bypass it. That
// tag exists for specific Meta-approved use cases (e.g. a human agent
// replying within 7 days), not for letting *our* automation slip past the
// 24-hour window, which would be exactly the "bypass a platform limitation
// through an unofficial/automated path" spec §41 forbids.
export async function sendMessage(
  accountId: string,
  conversationId: string,
  text: string,
): Promise<SendMessageResult> {
  const { response, json } = await callSocialApi(
    "inbox.send",
    `/inbox/conversations/${conversationId}/messages`,
    { method: "POST", body: { account_id: accountId, text } },
  );
  const body = json as { success?: boolean; message_id?: string } | null;

  if (!response.ok || body?.success !== true || !body?.message_id) {
    throw new InstagramApiError(
      "Failed to send the Instagram message.",
      "INSTAGRAM_API_ERROR",
      diagnosticDetails(response, json),
    );
  }

  return { externalMessageId: body.message_id };
}

export type ConnectedAccount = {
  id: string;
  platform: string;
  username: string;
  name?: string;
  status: string;
  profilePictureUrl?: string;
};

// `GET /accounts` — used by Settings to show connection health, and
// available for debugging/verification against the real API.
export async function listConnectedAccounts(): Promise<ConnectedAccount[]> {
  const { response, json } = await callSocialApi("accounts.list", "/accounts");
  const body = json as
    | { data?: Array<{ id: string; platform: string; username: string; name?: string; status: string; profile_picture_url?: string }> }
    | null;

  if (!response.ok || !body?.data) {
    throw new InstagramApiError(
      "Failed to load connected Instagram accounts.",
      "INSTAGRAM_API_ERROR",
      diagnosticDetails(response, json),
    );
  }

  return body.data.map((a) => ({
    id: a.id,
    platform: a.platform,
    username: a.username,
    name: a.name,
    status: a.status,
    profilePictureUrl: a.profile_picture_url,
  }));
}

// `DELETE /accounts/{id}` — soft-deletes the connection on SocialAPI.AI's
// side: it drops off `listConnectedAccounts()` and every further call
// using it 404s. Treated as idempotent here — a 404 (already gone, e.g.
// disconnected directly from SocialAPI.AI's own dashboard) counts as
// success, since the end state either way is "not connected."
export async function disconnectSocialAccount(accountId: string): Promise<void> {
  const { response, json } = await callSocialApi(
    "accounts.disconnect",
    `/accounts/${accountId}`,
    { method: "DELETE" },
  );

  if (!response.ok && response.status !== 404) {
    throw new InstagramApiError(
      "Failed to disconnect the Instagram account.",
      "INSTAGRAM_API_ERROR",
      diagnosticDetails(response, json),
    );
  }
}
