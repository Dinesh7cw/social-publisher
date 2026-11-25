/**
 * Adapter registry.
 *
 * The single place that maps a platform to its implementation. Callers ask for
 * an adapter by platform id and never import a concrete adapter directly, so
 * adding a network is one entry here plus its own folder.
 *
 * A platform with no entry has no adapter: there is no fallback, no default and
 * no "probably fine" cast. That way it is impossible to publish through the
 * wrong adapter because a flag was set.
 */

import type { PlatformId } from "@/lib/domain";
import { PLATFORMS } from "@/lib/domain";
import { ApiError } from "@/server/http";
import { resolveAppCredentials } from "@/server/services/platform-credentials";
import type { PlatformAdapter } from "./types";
import { facebookAdapter } from "./facebook/adapter";
import { instagramAdapter } from "./instagram/adapter";
import { linkedinAdapter } from "./linkedin/adapter";
import { xAdapter } from "./x/adapter";

const ADAPTERS: Partial<Record<PlatformId, PlatformAdapter>> = {
  FACEBOOK: facebookAdapter,
  INSTAGRAM: instagramAdapter,
  LINKEDIN: linkedinAdapter,
  X: xAdapter,
};

export function isImplemented(platform: PlatformId): boolean {
  return ADAPTERS[platform] !== undefined;
}

/**
 * True when the platform is implemented AND has app credentials.
 *
 * Credentials are the gate, not a separate on/off flag: a flag that says
 * "enabled" while the app id is missing only moves the failure to the first API
 * call, where the message is worse. Async because the credentials may live in
 * the database, where an admin saved them.
 */
export async function isPlatformAvailable(platform: PlatformId): Promise<boolean> {
  return isImplemented(platform) && (await resolveAppCredentials(platform)) !== null;
}

export type AvailabilityReason = "available" | "not_built" | "not_configured";

export interface PlatformStatus {
  platform: PlatformId;
  available: boolean;
  reason: AvailabilityReason;
  /** Shown to the team in plain words. Never leaks configuration detail. */
  message: string | null;
}

export async function platformStatus(platform: PlatformId): Promise<PlatformStatus> {
  if (!isImplemented(platform)) {
    return {
      platform,
      available: false,
      reason: "not_built",
      message: "Not available yet",
    };
  }
  if ((await resolveAppCredentials(platform)) === null) {
    return {
      platform,
      available: false,
      reason: "not_configured",
      message: "Credentials needed",
    };
  }
  return { platform, available: true, reason: "available", message: null };
}

export async function allPlatformStatuses(): Promise<PlatformStatus[]> {
  return Promise.all(PLATFORMS.map((platform) => platformStatus(platform)));
}

/**
 * Get an adapter for publishing.
 *
 * Throws a clear, user-facing error when the platform is not usable, so the
 * worker records a permanent failure with an actionable message rather than a
 * stack trace.
 */
export async function getAdapter(platform: PlatformId): Promise<PlatformAdapter> {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    throw new ApiError("PLATFORM_DISABLED", `${platform} posting is not available in this build.`);
  }
  if ((await resolveAppCredentials(platform)) === null) {
    throw new ApiError(
      "PLATFORM_DISABLED",
      `${platform} is not enabled yet. An admin needs to add its app credentials.`,
    );
  }
  return adapter;
}

/** Non-throwing lookup, for validation and preview where absence is expected. */
export function findAdapter(platform: PlatformId): PlatformAdapter | null {
  return ADAPTERS[platform] ?? null;
}
