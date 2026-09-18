import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: {
    META_APP_ID: "test-app-id",
    META_APP_SECRET: "test-app-secret",
    META_GRAPH_API_VERSION: "v26.0",
    NEXTAUTH_URL: "http://localhost:3000",
  },
}));
vi.mock("@/lib/validation/env", () => ({ env: envMock }));

const { InstagramApiError } = await import("@/lib/instagram/errors");
const {
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  getAuthorizationUrl,
  getProfile,
  subscribeToMessageWebhooks,
  sendMessage,
} = await import("@/services/instagram/instagram-service");

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe("getAuthorizationUrl", () => {
  beforeEach(() => {
    envMock.META_APP_ID = "test-app-id";
    envMock.META_APP_SECRET = "test-app-secret";
  });

  it("builds the direct Instagram Business Login authorize URL with the required params", () => {
    const url = new URL(getAuthorizationUrl("csrf-state-1"));

    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-app-id");
    expect(url.searchParams.get("state")).toBe("csrf-state-1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/instagram/callback",
    );
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_messages",
    );
  });

  it("throws when Instagram isn't configured on this server", () => {
    envMock.META_APP_ID = "";
    expect(() => getAuthorizationUrl("state")).toThrow(InstagramApiError);
  });
});

describe("fetch-backed Instagram calls", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    envMock.META_APP_ID = "test-app-id";
    envMock.META_APP_SECRET = "test-app-secret";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchangeCodeForShortLivedToken returns the token on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ access_token: "short-token", user_id: 12345, permissions: "a,b" }],
      }),
    );

    const result = await exchangeCodeForShortLivedToken("auth-code");

    expect(result).toEqual({
      accessToken: "short-token",
      instagramUserId: "12345",
      permissions: ["a", "b"],
    });
  });

  it("accepts Instagram Login's direct token response shape", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: "short-token",
        user_id: 12345,
        permissions: ["instagram_business_basic", "instagram_business_manage_messages"],
      }),
    );

    const result = await exchangeCodeForShortLivedToken("auth-code");

    expect(result).toEqual({
      accessToken: "short-token",
      instagramUserId: "12345",
      permissions: ["instagram_business_basic", "instagram_business_manage_messages"],
    });
  });

  it("exchangeCodeForShortLivedToken throws InstagramApiError when Meta rejects the code", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: "invalid code" } }),
    );

    await expect(exchangeCodeForShortLivedToken("bad-code")).rejects.toThrow(
      InstagramApiError,
    );
  });

  it("exchangeForLongLivedToken returns the exchanged token on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: "long-token", expires_in: 5184000 }),
    );

    const result = await exchangeForLongLivedToken("short-token");
    expect(result).toEqual({ accessToken: "long-token", expiresInSeconds: 5184000 });
  });

  it("getProfile returns the parsed profile on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 999,
        username: "someuser",
        account_type: "BUSINESS",
        profile_picture_url: "https://example.com/p.jpg",
      }),
    );

    const profile = await getProfile("access-token");

    expect(profile).toEqual({
      id: "999",
      username: "someuser",
      accountType: "BUSINESS",
      profilePictureUrl: "https://example.com/p.jpg",
    });

    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.pathname).toBe("/v26.0/me");
  });

  it("getProfile throws InstagramApiError when the profile fetch fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));

    await expect(getProfile("bad-token")).rejects.toThrow(InstagramApiError);
  });

  it("subscribes the Instagram account to message webhooks", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));

    await subscribeToMessageWebhooks("access-token", "instagram-user-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "https://graph.instagram.com/v26.0/instagram-user-1/subscribed_apps",
    );
    expect(init.method).toBe("POST");
    expect(init.body.toString()).toContain("subscribed_fields=messages");
    expect(init.body.toString()).toContain("access_token=access-token");
  });

  it("sendMessage posts to the versioned messages endpoint and returns the message id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { message_id: "mid.999" }));

    const result = await sendMessage("access-token", "sender-1", "recipient-1", "Hi!");

    expect(result).toEqual({ externalMessageId: "mid.999" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.instagram.com/v26.0/sender-1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer access-token");
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: "recipient-1" },
      message: { text: "Hi!" },
    });
  });

  it("sendMessage throws InstagramApiError and never bypasses the window itself when Meta refuses the send", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "outside window" }));

    await expect(sendMessage("token", "sender-1", "recipient-1", "Hi!")).rejects.toThrow(
      InstagramApiError,
    );
    // sendMessage never adds a human_agent tag or any window-bypass field.
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).not.toHaveProperty("tag");
  });
});
