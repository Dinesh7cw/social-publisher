import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { route, ApiError, invalid } from "@/server/http";
import { getSession } from "@/server/auth/session";
import { consumeOAuthState } from "@/server/auth/oauth-state";
import { findAdapter } from "@/server/platforms/registry";
import { resolveAppCredentials } from "@/server/services/platform-credentials";
import { encryptSecret } from "@/lib/crypto";
import { prisma } from "@/server/db";
import { PLATFORMS, type PlatformId } from "@/lib/domain";

type Params = { params: Promise<{ platform: string }> };

/**
 * OAuth callback.
 *
 * The state is validated and consumed before anything else happens. A mismatch
 * aborts with a message, never by proceeding: accepting a bad state is how an
 * attacker's social account ends up attached to CW's clients.
 *
 * The discovered accounts and the obtained tokens are stored in a short-lived
 * ConnectSession (encrypted) rather than being written straight to
 * SocialAccount, because the team still has to choose which accounts to attach to
 * which client — Meta returns many Pages, LinkedIn a member plus organisations.
 */
export const GET = route(async (request: Request, { params }: Params) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(`${env().APP_URL}/login?next=%2Faccounts`);
  }

  const { platform: rawPlatform } = await params;
  const platform = rawPlatform.toUpperCase() as PlatformId;

  if (!PLATFORMS.includes(platform)) throw invalid("Unknown platform.");

  // Resolved here rather than in the adapter, so a credential saved from the
  // Credentials page is the one used to complete this exchange.
  const credentials = await resolveAppCredentials(platform);
  if (!credentials) {
    throw new ApiError("PLATFORM_DISABLED", `${platform} is not configured on this deployment.`);
  }

  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // The user declined on the platform's own screen.
  if (errorParam) {
    const reason = encodeURIComponent(errorDescription ?? errorParam);
    return NextResponse.redirect(
      `${env().APP_URL}/accounts?connect_error=${reason}`,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) throw invalid("The platform did not return an authorization code.");

  const validation = await consumeOAuthState({ state, sessionUserId: session.user.id });

  if (!validation.ok) {
    // Deliberately vague to the user, precise in the log.
    console.warn("[oauth] state rejected", { reason: validation.reason, platform });
    return NextResponse.redirect(
      `${env().APP_URL}/accounts?connect_error=${encodeURIComponent(
        validation.reason === "expired"
          ? "That connection attempt expired. Please start again."
          : "This connection could not be verified. Please start again.",
      )}`,
    );
  }

  const adapter = findAdapter(platform);
  if (!adapter) throw new ApiError("PLATFORM_DISABLED", `${platform} is not available.`);

  // Return to where the flow started (a client's Accounts tab, say) and fall
  // back to the agency-wide list. The session id is appended either way.
  const returnBase = validation.redirectTo ? `${env().APP_URL}${validation.redirectTo}` : `${env().APP_URL}/accounts`;

  const redirectUri = `${env().APP_URL}/api/accounts/connect/${platform.toLowerCase()}/callback`;

  const exchanged = await adapter.exchangeCode({
    code,
    redirectUri,
    codeVerifier: validation.codeVerifier ?? undefined,
    credentials: {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      version: credentials.config.version,
    },
  });

  if (!exchanged.ok) {
    return NextResponse.redirect(
      `${returnBase}?connect_error=${encodeURIComponent(exchanged.error.userMessage)}`,
    );
  }

  // Meta: trade the short-lived user token for a long-lived one so Page tokens
  // do not expire and scheduled posts keep working.
  let tokens = exchanged.tokens;
  if (adapter.exchangeForLongLived) {
    tokens = await adapter
      .exchangeForLongLived(tokens, {
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        version: credentials.config.version,
      })
      .catch(() => tokens);
  }

  const discovered = await adapter.listAccounts(tokens);

  if (!discovered.ok) {
    return NextResponse.redirect(
      `${returnBase}?connect_error=${encodeURIComponent(discovered.error.userMessage)}`,
    );
  }

  if (discovered.accounts.length === 0) {
    return NextResponse.redirect(
      `${returnBase}?connect_error=${encodeURIComponent(
        "No accounts could be published to with that login. Check that the account has the right role on the page.",
      )}`,
    );
  }

  // Store the discovered accounts encrypted, keyed to this session, so the
  // picker step can write the chosen ones without another round-trip to the
  // platform.
  const connectSession = await prisma.connectSession.create({
    data: {
      userId: session.user.id,
      platform,
      payloadCipher: encryptSecret(
        JSON.stringify({
          accounts: discovered.accounts.map((account) => ({
            externalId: account.externalId,
            displayName: account.displayName,
            accountType: account.accountType,
            accessToken: account.accessToken ?? tokens.accessToken,
            tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
            scopes: account.scopes ?? tokens.scopes ?? [],
            handle: account.handle ?? null,
          })),
          refreshToken: tokens.refreshToken ?? null,
          // The user token is kept separately from the Page token because
          // Instagram deletion requires it and a Page token will not do. Its
          // expiry is stored alongside so it can be renewed before it lapses.
          userToken: tokens.accessToken,
          userTokenExpiresAt: tokens.expiresAt?.toISOString() ?? null,
          defaultScopes: tokens.scopes ?? [],
        }),
      ),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  return NextResponse.redirect(
    `${returnBase}?connect_session=${connectSession.id}&platform=${platform}`,
  );
});
