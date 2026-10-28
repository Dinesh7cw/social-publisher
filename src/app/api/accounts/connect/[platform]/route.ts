import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { route, ApiError, invalid } from "@/server/http";
import { rateLimit, LIMITS } from "@/server/rate-limit";
import { getSession } from "@/server/auth/session";
import { clientIp } from "@/server/request";
import { createOAuthState } from "@/server/auth/oauth-state";
import { generatePkcePair } from "@/server/platforms/x/adapter";
import { findAdapter, isPlatformAvailable } from "@/server/platforms/registry";
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

  if (!isPlatformAvailable(platform)) {
    throw new ApiError(
      "PLATFORM_DISABLED",
      `${platform} cannot be connected on this deployment yet. An admin needs to complete its setup.`,
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

  const adapter = findAdapter(platform);
  if (!adapter) {
    throw new ApiError("PLATFORM_DISABLED", `${platform} is not available in this build.`);
  }

  // PKCE is required by X and harmless elsewhere, so one code path serves all.
  const pkce = generatePkcePair();

  const state = await createOAuthState({
    userId: session.user.id,
    platform,
    codeVerifier: pkce.verifier,
  });

  const redirectUri = `${env().APP_URL}/api/accounts/connect/${platform.toLowerCase()}/callback`;

  const authorizeUrl = adapter.buildAuthorizeUrl({
    state,
    redirectUri,
    codeChallenge: pkce.challenge,
  });

  return NextResponse.json({ authorizeUrl });
});
