/**
 * AES-256-GCM envelope encryption for OAuth tokens.
 *
 * Envelope format:
 *   v1.<keyId>.<iv-b64>.<tag-b64>.<ciphertext-b64>
 *
 * - The version prefix allows a future scheme change without a data migration.
 * - The key id allows key rotation: old ciphertexts keep decrypting while new
 *   writes use the current key.
 * - GCM gives us authentication: a tampered ciphertext throws rather than
 *   returning garbage that we might later send to a platform.
 *
 * The plaintext must never be logged, serialised into an API response, or
 * stored anywhere but memory for the duration of a single API call.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";

import { env } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const KEY_ID = "k1"; // bump when the key rotates

function currentKey(): Buffer {
  const raw = env().TOKEN_ENCRYPTION_KEY;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TypeError("Cannot encrypt an empty secret");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, currentKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    KEY_ID,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 5) {
    throw new Error("Malformed secret envelope");
  }

  const [version, keyId, ivB64, tagB64, dataB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new Error(`Unsupported secret envelope version: ${version}`);
  }
  if (keyId !== KEY_ID) {
    throw new Error(`Unknown encryption key id: ${keyId}`);
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  if (iv.length !== IV_LENGTH || tag.length !== 16) {
    throw new Error("Malformed secret envelope");
  }

  const decipher = createDecipheriv(ALGORITHM, currentKey(), iv);
  decipher.setAuthTag(tag);

  // final() throws if the authentication tag does not match, which is exactly
  // the behaviour we want for tampered data.
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** True when a stored value can be decrypted with the current key. */
export function canDecrypt(envelope: string): boolean {
  try {
    decryptSecret(envelope);
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison, for any secret compared against user input
 * (session tokens, state nonces).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Salted hash for values that are useful to correlate but must not be stored
 * raw (IP addresses in sessions and audit logs).
 */
export function hashIdentifier(value: string): string {
  return createHash("sha256")
    .update(`${env().SESSION_SECRET}:${value}`)
    .digest("hex")
    .slice(0, 32);
}
