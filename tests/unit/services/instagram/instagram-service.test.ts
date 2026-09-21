import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: {
    SOCIALAPI_TOKEN: "test-socialapi-token",
    SOCIALAPI_WEBHOOK_SECRET: "test-webhook-secret",
    NEXTAUTH_URL: "http://localhost:3000",
  },
}));
vi.mock("@/lib/validation/env", () => ({ env: envMock }));

const { InstagramApiError } = await import("@/lib/instagram/errors");
const {
  disconnectSocialAccount,
  exchangeOAuthCode,
  getConnectAuthUrl,
  listConnectedAccounts,
  sendMessage,
} = await import("@/services/instagram/instagram-service");

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 || status === 201 || status === 202 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

describe("fetch-backed SocialAPI.AI calls", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    envMock.SOCIALAPI_TOKEN = "test-socialapi-token";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getConnectAuthUrl returns the auth_url shape for the OAuth flow", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(202, { auth_url: "https://www.instagram.com/oauth/authorize/?x=1", state: "echoed-state" }),
    );

    const result = await getConnectAuthUrl("csrf-state-1");

    expect(result).toEqual({
      kind: "auth_url",
      authUrl: "https://www.instagram.com/oauth/authorize/?x=1",
      state: "echoed-state",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.social-api.ai/v1/accounts/connect");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-socialapi-token");
    expect(JSON.parse(init.body)).toEqual({
      platform: "instagram",
      redirect_uri: "http://localhost:3000/api/instagram/callback",
      state: "csrf-state-1",
    });
  });

  it("getConnectAuthUrl throws InstagramApiError when the API rejects the request", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: "auth", message: "bad key" } }));

    await expect(getConnectAuthUrl("state")).rejects.toThrow(InstagramApiError);
  });

  it("exchangeOAuthCode returns the connected account on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { account_id: "acc_1", username: "someuser", display_name: "Some User" }),
    );

    const result = await exchangeOAuthCode("auth-code", "csrf-state-1");

    expect(result).toEqual({ accountId: "acc_1", username: "someuser", displayName: "Some User" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.social-api.ai/v1/oauth/exchange");
    expect(JSON.parse(init.body)).toEqual({
      code: "auth-code",
      platform: "instagram",
      metadata: { redirect_uri: "http://localhost:3000/api/instagram/callback", state: "csrf-state-1" },
    });
  });

  it("exchangeOAuthCode throws InstagramApiError when the code is rejected", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: { code: "invalid_code", message: "expired" } }));

    await expect(exchangeOAuthCode("bad-code", "state")).rejects.toThrow(InstagramApiError);
  });

  it("sendMessage posts to the conversation's messages endpoint and returns the message id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, message_id: "m_999" }));

    const result = await sendMessage("acc_1", "conv_1", "Hi!");

    expect(result).toEqual({ externalMessageId: "m_999" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.social-api.ai/v1/inbox/conversations/conv_1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ account_id: "acc_1", text: "Hi!" });
  });

  it("sendMessage throws InstagramApiError when the send fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { success: false }));

    await expect(sendMessage("acc_1", "conv_1", "Hi!")).rejects.toThrow(InstagramApiError);
  });

  it("listConnectedAccounts returns the parsed account list", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        count: 1,
        data: [
          {
            id: "acc_1",
            platform: "instagram",
            username: "someuser",
            name: "Some User",
            status: "active",
            profile_picture_url: "https://example.com/p.jpg",
          },
        ],
      }),
    );

    const result = await listConnectedAccounts();

    expect(result).toEqual([
      {
        id: "acc_1",
        platform: "instagram",
        username: "someuser",
        name: "Some User",
        status: "active",
        profilePictureUrl: "https://example.com/p.jpg",
      },
    ]);
  });

  it("disconnectSocialAccount succeeds on a 204 response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      json: async () => {
        throw new Error("no body");
      },
    } as unknown as Response);

    await expect(disconnectSocialAccount("acc_1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.social-api.ai/v1/accounts/acc_1");
    expect(init.method).toBe("DELETE");
  });

  it("disconnectSocialAccount treats a 404 as success (already gone)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: "resource.not_found", message: "Account not found" } }),
    );

    await expect(disconnectSocialAccount("acc_1")).resolves.toBeUndefined();
  });

  it("disconnectSocialAccount throws InstagramApiError on a real failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: "auth", message: "bad key" } }));

    await expect(disconnectSocialAccount("acc_1")).rejects.toThrow(InstagramApiError);
  });
});
