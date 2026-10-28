/**
 * Password hashing.
 *
 * argon2id with parameters at or above the OWASP 2024 recommendation for
 * interactive logins. The hash is stored in PHC string format, so parameters
 * travel with the hash and can be upgraded without a schema change.
 */

import { hash, verify } from "@node-rs/argon2";

// argon2id is selected by the numeric value 2 in the options below. The library
// also exports an `Algorithm` const enum, which cannot be used under
// isolatedModules, so the documented numeric value is used instead.
const ARGON2ID = 2 as const;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hashString: string, password: string): Promise<boolean> {
  try {
    return await verify(hashString, password);
  } catch {
    // A malformed hash must read as "wrong password", never as a crash that
    // leaks whether the account exists.
    return false;
  }
}

/**
 * Password policy.
 *
 * Length is the dominant factor in real-world strength, so the rule is a floor
 * of 12 characters rather than a pile of character-class tests that push people
 * towards "Passw0rd!".
 */
export const PASSWORD_MIN_LENGTH = 12;

const COMMON_PASSWORDS = new Set([
  "password1234",
  "passwordpassword",
  "qwertyuiop12",
  "letmein12345",
  "administrator",
  "welcome12345",
  "changeme1234",
]);

export function validatePasswordStrength(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > 200) {
    return "Password is too long.";
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "This password is too common.";
  }
  return null;
}
