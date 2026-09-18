import { describe, expect, it } from "vitest";

import { decrypt, encrypt } from "@/lib/security/encryption";

describe("encrypt/decrypt (AES-256-GCM)", () => {
  it("round-trips a plaintext string", () => {
    const plaintext = "IGAAsomeRealisticLookingAccessTokenValue1234567890";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", () => {
    const plaintext = "same-input-twice";
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
  });

  it("never returns the plaintext itself as the ciphertext", () => {
    const plaintext = "super-secret-token";
    expect(encrypt(plaintext)).not.toContain(plaintext);
  });

  it("throws when the ciphertext has been tampered with (auth tag mismatch)", () => {
    const ciphertext = encrypt("some token");
    const tampered = Buffer.from(ciphertext, "base64");
    tampered[tampered.length - 1] ^= 0xff; // flip the last ciphertext byte
    expect(() => decrypt(tampered.toString("base64"))).toThrow();
  });

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });
});
