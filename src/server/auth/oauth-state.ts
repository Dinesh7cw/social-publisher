/**
 * OAuth state management.
 *
 * The state parameter is the defence against a cross-site request forgery that
 * attaches an attacker's social account to CW's tenant, or that swaps the account
 * mid-flow. Rules:
 *
 *  - state is a random 32-byte value, unguessable,
 *  - it is stored server-side and bound to the initiating session,
 *  - it is single-use: consumed atomically, so a replay fails,
 *  - it expires in 10 minutes,
 *  - the PKCE verifier is stored with it, never in the browser.
 */

import { randomBytes } from "node:crypto";

import { prisma } from "@/server/db";
import type { PlatformId } from "@/lib/domain";

const STATE_TTL_MS = 10 * 60 * 1000;

export async function createOAuthState(params: {
  userId: string;
  platform: PlatformId;
  codeVerifier?: string | null;
  redirectTo?: string | null;
}): Promise<string> {
  const id = randomBytes(32).toString("base64url");

  await prisma.oAuthState.create({
    data: {
      id,
      userId: params.userId,
      platform: params.platform,
      codeVerifier: params.codeVerifier ?? null,
      redirectTo: params.redirectTo ?? null,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });

  return id;
}

export type StateValidation =
  | { ok: true; userId: string; platform: PlatformId; codeVerifier: string | null; redirectTo: string | null }
  | { ok: false; reason: "missing" | "unknown" | "expired" | "already_used" | "session_mismatch" };

/**
 * Consume a state value.
 *
 * The `updateMany` with `consumedAt: null` makes consumption atomic: two
 * concurrent callbacks with the same state cannot both succeed.
 */
export async function consumeOAuthState(params: {
  state: string | null;
  sessionUserId: string;
}): Promise<StateValidation> {
  if (!params.state) return { ok: false, reason: "missing" };

  const record = await prisma.oAuthState.findUnique({ where: { id: params.state } });

  if (!record) return { ok: false, reason: "unknown" };
  if (record.consumedAt) return { ok: false, reason: "already_used" };
  if (record.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  // The state must belong to the person who is now signed in.
  if (record.userId !== params.sessionUserId) {
    return { ok: false, reason: "session_mismatch" };
  }

  const consumed = await prisma.oAuthState.updateMany({
    where: { id: params.state, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (consumed.count !== 1) return { ok: false, reason: "already_used" };

  return {
    ok: true,
    userId: record.userId,
    platform: record.platform as PlatformId,
    codeVerifier: record.codeVerifier,
    redirectTo: record.redirectTo,
  };
}

/** Housekeeping. */
export async function pruneExpiredOAuthState(): Promise<number> {
  const result = await prisma.oAuthState.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  return result.count;
}
