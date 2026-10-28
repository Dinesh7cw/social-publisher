import { describe, expect, it } from "vitest";

import {
  canDecrypt,
  decryptSecret,
  encryptSecret,
  hashIdentifier,
  safeEqual,
} from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";

describe("secret encryption", () => {
  it("round-trips a token", () => {
    const token = "EAAGm0PX4ZCpsBAK9ZCZBq7xWvExamplePageToken1234567890";
    const envelope = encryptSecret(token);
    expect(decryptSecret(envelope)).toBe(token);
  });

  it("produces a different ciphertext for the same plaintext (random IV)", () => {
    const token = "same-token-value";
    const a = encryptSecret(token);
    const b = encryptSecret(token);
    expect(a).not.toBe(b);
    // Both must still decrypt to the same value.
    expect(decryptSecret(a)).toBe(token);
    expect(decryptSecret(b)).toBe(token);
  });

  it("uses the documented envelope shape", () => {
    const envelope = encryptSecret("value");
    const parts = envelope.split(".");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("k1");
  });

  it("rejects tampered ciphertext rather than returning garbage", () => {
    const envelope = encryptSecret("a-real-refresh-token");
    const parts = envelope.split(".");
    // Flip a character in the payload.
    const payload = parts[4] as string;
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      parts[3],
      payload.slice(0, -4) + (payload.endsWith("AAAA") ? "BBBB" : "AAAA"),
    ].join(".");

    expect(() => decryptSecret(tampered)).toThrow();
    expect(canDecrypt(tampered)).toBe(false);
  });

  it("rejects a tampered authentication tag", () => {
    const envelope = encryptSecret("another-token");
    const parts = envelope.split(".");
    const tag = Buffer.from(parts[3] as string, "base64");
    tag[0] = (tag[0] as number) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], tag.toString("base64"), parts[4]].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptSecret("not-an-envelope")).toThrow(/Malformed/);
    expect(() => decryptSecret("v1.k1.only-three")).toThrow(/Malformed/);
  });

  it("rejects an unknown envelope version", () => {
    const envelope = encryptSecret("x");
    const parts = envelope.split(".");
    expect(() => decryptSecret(["v9", ...parts.slice(1)].join("."))).toThrow(/version/i);
  });

  it("refuses to encrypt an empty secret", () => {
    expect(() => encryptSecret("")).toThrow(TypeError);
  });

  it("refuses to decrypt with a rotated key", () => {
    const envelope = encryptSecret("token-under-old-key");
    const originalKey = process.env.TOKEN_ENCRYPTION_KEY!;

    // Simulate a key rotation by swapping the key while keeping the envelope
    // and its keyId. A correctly-built system will fail closed.
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    resetEnvCache();

    try {
      expect(() => decryptSecret(envelope)).toThrow();
      expect(canDecrypt(envelope)).toBe(false);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = originalKey;
      resetEnvCache();
    }
  });
});

describe("constant-time comparison", () => {
  it("matches identical strings", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });

  it("rejects strings of different length", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("identifier hashing", () => {
  it("is stable for the same input", () => {
    expect(hashIdentifier("203.0.113.4")).toBe(hashIdentifier("203.0.113.4"));
  });

  it("does not contain the raw value", () => {
    const raw = "203.0.113.4";
    expect(hashIdentifier(raw)).not.toContain(raw);
  });

  it("differs for different inputs", () => {
    expect(hashIdentifier("203.0.113.4")).not.toBe(hashIdentifier("203.0.113.5"));
  });
});
