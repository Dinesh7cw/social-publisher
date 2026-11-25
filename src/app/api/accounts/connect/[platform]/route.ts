import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { route, ApiError, invalid } from "@/server/http";
import { rateLimit, LIMITS } from "@/server/rate-limit";
import { getSession } from "@/server/auth/session";
import { clientIp } from "@/server/request";
import { createOAuthState } from "@/server/auth/oauth-state";
import { generatePkcePair } from "@/server/platforms/x/adapter";
import { findAdapter } from "@/server/platforms/registry";
import { resolveAppCredentials } from "@/server/services/platform-credentials";
import { PLATFORMS, type PlatformId } from "@/lib/domain";

type Params = { params: Promise<{ platform: string }> };

/**
 * Begin an OAuth connection.
 *
 * Returns the authorize URL rather than redirecting, so the client can surface an
 * error inline when a platform is not configured instead of stranding the user on
 * a platform error page.
 */
export const GET = route(async (request: Request, { params }: Params) => {
  const session = await getSession();
  if (!session) throw new ApiError("UNAUTHENTICATED", "Please sign in to connect an account.");

  const { platform: rawPlatform } = await params;
  const platform = rawPlatform.toUpperCase() as PlatformId;

  if (!PLATFORMS.includes(platform)) throw invalid("Unknown platform.");

  const adapter = findAdapter(platform);
  if (!adapter) {
    throw new ApiError("PLATFORM_DISABLED", `${platform} is not available in this build.`);
  }

  // Read the credentials before anything else: an unconfigured platform should
  // say so plainly and point at the page that fixes it, rather than fail later
  // inside the platform's own consent screen.
  const credentials = await resolveAppCredentials(platform);
  if (!credentials) {
    throw new ApiError(
      "PLATFORM_DISABLED",
      `${platform} has no app credentials yet. An admin can add them under Credentials.`,
    );
  }

  const limit = await rateLimit({
    bucket: "oauth:start",
    identifier: `${session.user.id}:${clientIp(request)}`,
    ...LIMITS.oauth,
  });

  if (!limit.allowed) {
    throw new ApiError("RATE_LIMITED", "Too many connection attempts. Please wait a moment.");
  }

  // PKCE is required by X and harmless elsewhere, so one code path serves all.
  const pkce = generatePkcePair();

  // Where to land after the platform sends us back. Only a same-origin path is
  // accepted — a full URL here would turn the OAuth flow into an open redirect.
  const requestedReturn = new URL(request.url).searchParams.get("returnTo");
  const redirectTo =
    requestedReturn && requestedReturn.startsWith("/") && !requestedReturn.startsWith("//")
      ? requestedReturn
      : null;

  const state = await createOAuthState({
    userId: session.user.id,
    platform,
    codeVerifier: pkce.verifier,
    redirectTo,
  });

  const redirectUri = `${env().APP_URL}/api/accounts/connect/${platform.toLowerCase()}/callback`;

  const authorizeUrl = adapter.buildAuthorizeUrl({
    state,
    redirectUri,
    codeChallenge: pkce.challenge,
    credentials: {
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      version: credentials.config.version,
    },
  });

  return NextResponse.json({ authorizeUrl });
});
