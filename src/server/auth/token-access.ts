/**
 * The one place tokens are decrypted.
 *
 * Nothing else in the codebase calls decryptSecret for account tokens. That
 * means there is exactly one function to audit, and exactly one place a bug
 * could expose a token. It returns the plaintext for the duration of a single
 * API call and never caches it.
 */

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";

export interface AccountCredentials {
  accessToken: string;
  /**
   * The connecting user's own token, where the platform gave us one. Meta's
   * Instagram delete endpoint rejects a Page token, so this is the only
   * credential that can remove an Instagram post.
   */
  userAccessToken: string | null;
  refreshToken: string | null;
  tokenType: string | null;
  expiresAt: Date | null;
  scopes: string[];
  platform: "FACEBOOK" | "INSTAGRAM" | "LINKEDIN" | "X";
  externalId: string;
  accountType: string;
  accountId: string;
  clientId: string;
  displayName: string;
  status: "CONNECTED" | "EXPIRED" | "REVOKED" | "ERROR";
}

/**
 * Load and decrypt the credentials for one account.
 *
 * Throws PLATFORM_AUTH_EXPIRED when the account is not in a usable state, so
 * the worker marks the target `NEEDS_RECONNECT` instead of making a doomed call.
 */
export async function getAccountCredentials(accountId: string): Promise<AccountCredentials> {
  const account = await prisma.socialAccount.findUnique({
    where: { id: accountId },
    include: { secret: true },
  });

  if (!account) throw new ApiError("NOT_FOUND", "Social account not found.");
  if (!account.secret) {
    throw new ApiError(
      "PLATFORM_AUTH_EXPIRED",
      `${account.displayName} needs to be reconnected before it can publish.`,
    );
  }
  if (account.status === "REVOKED") {
    throw new ApiError(
      "PLATFORM_AUTH_EXPIRED",
      `${account.displayName} was disconnected. Reconnect it to publish.`,
    );
  }

  let accessToken: string;
  let refreshToken: string | null = null;
  let userAccessToken: string | null = null;

  try {
    accessToken = decryptSecret(account.secret.accessTokenCipher);
    if (account.secret.refreshTokenCipher) {
      refreshToken = decryptSecret(account.secret.refreshTokenCipher);
    }
    if (account.secret.userTokenCipher) {
      userAccessToken = decryptSecret(account.secret.userTokenCipher);
    }
  } catch {
    // A decryption failure means the key rotated without re-encrypting, or the
    // row was tampered with. Either way the account must be reconnected.
    throw new ApiError(
      "PLATFORM_AUTH_EXPIRED",
      `${account.displayName} cannot be authenticated. Reconnect it to continue.`,
    );
  }

  return {
    accessToken,
    userAccessToken,
    refreshToken,
    tokenType: account.secret.tokenType,
    expiresAt: account.tokenExpiresAt,
    scopes: account.scopes,
    platform: account.platform,
    externalId: account.externalId,
    accountType: account.accountType,
    accountId: account.id,
    clientId: account.clientId,
    displayName: account.displayName,
    status: account.status,
  };
}

/**
 * A cheap pre-flight check.
 *
 * Returns true when the token is expired or about to be. Adapters call this
 * before publishing so they can refresh first instead of failing at the API.
 */
export function isTokenExpired(expiresAt: Date | null, skewMs = 60_000): boolean {
  if (!expiresAt) return false; // non-expiring Page tokens
  return expiresAt.getTime() - skewMs <= Date.now();
}
