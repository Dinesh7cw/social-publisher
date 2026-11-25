/**
 * Meta user-token renewal.
 *
 * The token that can delete an Instagram post is a *Facebook user* token with
 * `instagram_manage_contents`, and Meta issues those for about 60 days. Page
 * tokens derived from a long-lived user token do not expire, so publishing keeps
 * working long after deletion has quietly stopped — which is the worst kind of
 * failure, because nobody notices until a takedown is needed.
 *
 * So: renew the user token on a schedule. Meta's extension endpoint accepts a
 * valid long-lived token (at least 24 hours old) and returns a fresh ~60 day one,
 * with no user interaction. That makes a monthly manual job unnecessary.
 *
 * Deliberately conservative:
 *  - A token with plenty of life left is skipped, so this does not burn a call
 *    per account per run.
 *  - A token that has already expired cannot be extended, and no retry will fix
 *    it. The account is marked EXPIRED so the UI asks for a reconnect instead of
 *    failing at the moment someone tries to delete a live post.
 *  - One account failing never stops the others.
 */

import { env } from "@/lib/env";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/server/db";
import { logger } from "@/server/logger";
import { recordAuditSafe } from "@/server/audit";
import { resolveAppCredentials } from "@/server/services/platform-credentials";
import { withQuery } from "@/server/platforms/http";

const log = logger.child({ service: "meta-token-refresh" });

const GRAPH_HOST = "https://graph.facebook.com";

/**
 * Renew when less than this much life is left.
 *
 * 50 days on a 60-day token means a run roughly every 10 days — comfortably
 * inside the window, with room for a missed run or two if the worker is down.
 */
export const RENEW_WITHIN_DAYS = 50;

/** No point calling Meta for a token that is already dead. */
const EXPIRY_GRACE_MS = 60 * 60 * 1000;

export type RenewalDecision = "renew" | "skip" | "expired";

/**
 * Decide what to do with a token, as a pure function of its expiry.
 *
 * Split out so the policy is testable without a database or a network call, and
 * so "why was this not renewed?" has one place to look.
 */
export function renewalDecision(
  expiresAt: Date | null,
  now: Date = new Date(),
): RenewalDecision {
  // An unknown expiry is not a reason to skip: the token may already be old, and
  // one wasted call is cheaper than a dead token.
  if (!expiresAt) return "renew";

  const remainingMs = expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) return "expired";
  if (remainingMs <= EXPIRY_GRACE_MS) return "expired";

  return remainingMs <= RENEW_WITHIN_DAYS * 24 * 60 * 60 * 1000 ? "renew" : "skip";
}

/**
 * Extend one Meta user token.
 *
 * Returns the new token and expiry, or an error string safe to log. Never
 * throws: one bad account must not abort the run.
 */
async function extendToken(params: {
  platform: "FACEBOOK" | "INSTAGRAM";
  token: string;
}): Promise<
  | { ok: true; accessToken: string; expiresAt: Date | null }
  | { ok: false; reason: string; requiresReconnect: boolean }
> {
  const credentials = await resolveAppCredentials(params.platform);
  if (!credentials) {
    return { ok: false, reason: "no_app_credentials", requiresReconnect: false };
  }

  const version = credentials.config.version ?? env().META_GRAPH_VERSION;

  try {
    const response = await fetch(
      withQuery(`${GRAPH_HOST}/${version}/oauth/access_token`, {
        grant_type: "fb_exchange_token",
        client_id: credentials.appId,
        client_secret: credentials.appSecret,
        fb_exchange_token: params.token,
      }),
      { method: "GET", signal: AbortSignal.timeout(15_000) },
    );

    const body = (await response.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; error?: { message?: string; code?: number } }
      | null;

    if (!response.ok || !body?.access_token) {
      const message = body?.error?.message ?? `HTTP ${response.status}`;
      // Meta reports an expired or revoked token as an OAuth error. Anything else
      // is worth another try on the next run.
      const fatal = body?.error?.code === 190 || /session has expired|invalid/i.test(message);
      return { ok: false, reason: message.slice(0, 200), requiresReconnect: fatal };
    }

    return {
      ok: true,
      accessToken: body.access_token,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 200) : "network_error",
      requiresReconnect: false,
    };
  }
}

export interface RefreshSummary {
  checked: number;
  renewed: number;
  skipped: number;
  expired: number;
  failed: number;
}

/**
 * One pass over every account that holds a Meta user token.
 *
 * Runs from the worker on boot and then daily; the per-token decision keeps the
 * actual renewal to roughly weekly.
 */
export async function refreshMetaUserTokens(now: Date = new Date()): Promise<RefreshSummary> {
  const summary: RefreshSummary = { checked: 0, renewed: 0, skipped: 0, expired: 0, failed: 0 };

  const secrets = await prisma.socialAccountSecret.findMany({
    where: {
      userTokenCipher: { not: null },
      socialAccount: { platform: { in: ["FACEBOOK", "INSTAGRAM"] } },
    },
    select: {
      socialAccountId: true,
      userTokenCipher: true,
      userTokenExpiresAt: true,
      socialAccount: {
        select: { id: true, platform: true, displayName: true, status: true },
      },
    },
  });

  for (const secret of secrets) {
    summary.checked += 1;
    const account = secret.socialAccount;
    const decision = renewalDecision(secret.userTokenExpiresAt, now);

    if (decision === "skip") {
      summary.skipped += 1;
      continue;
    }

    if (decision === "expired") {
      summary.expired += 1;
      await prisma.socialAccount
        .update({ where: { id: account.id }, data: { status: "EXPIRED" } })
        .catch(() => undefined);

      log.warn(
        { socialAccountId: account.id, platform: account.platform },
        "user token expired; Instagram deletion needs a reconnect",
      );
      continue;
    }

    let token: string;
    try {
      token = decryptSecret(secret.userTokenCipher!);
    } catch {
      summary.failed += 1;
      log.error({ socialAccountId: account.id }, "stored user token cannot be decrypted");
      continue;
    }

    const result = await extendToken({
      platform: account.platform === "INSTAGRAM" ? "INSTAGRAM" : "FACEBOOK",
      token,
    });

    if (!result.ok) {
      summary.failed += 1;

      if (result.requiresReconnect) {
        summary.expired += 1;
        await prisma.socialAccount
          .update({ where: { id: account.id }, data: { status: "EXPIRED" } })
          .catch(() => undefined);
      }

      log.warn(
        { socialAccountId: account.id, reason: result.reason, requiresReconnect: result.requiresReconnect },
        "user token renewal failed",
      );
      continue;
    }

    await prisma.socialAccountSecret.update({
      where: { socialAccountId: account.id },
      data: {
        userTokenCipher: encryptSecret(result.accessToken),
        userTokenExpiresAt: result.expiresAt,
        rotatedAt: new Date(),
      },
    });

    // If it had lapsed and come back, the account can publish and delete again.
    if (account.status === "EXPIRED") {
      await prisma.socialAccount
        .update({ where: { id: account.id }, data: { status: "CONNECTED" } })
        .catch(() => undefined);
    }

    summary.renewed += 1;
    await recordAuditSafe({
      actorId: null,
      action: "ACCOUNT_VERIFIED",
      entityType: "SocialAccount",
      entityId: account.id,
      metadata: {
        reason: "user_token_renewed",
        displayName: account.displayName,
        expiresAt: result.expiresAt?.toISOString() ?? null,
      },
    });
  }

  if (summary.checked > 0) log.info(summary, "meta user token pass complete");
  return summary;
}
