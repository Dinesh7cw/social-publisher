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
import { platformFlags } from "@/lib/env";
import { ApiError } from "@/server/http";
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

/** True when the platform is implemented AND configured AND enabled by flag. */
export function isPlatformAvailable(platform: PlatformId): boolean {
  return isImplemented(platform) && platformFlags[platform]();
}

export type AvailabilityReason =
  | "available"
  | "not_built"
  | "not_configured";

export interface PlatformStatus {
  platform: PlatformId;
  available: boolean;
  reason: AvailabilityReason;
  /** Shown to the team in plain words. Never leaks configuration detail. */
  message: string | null;
}

export function platformStatus(platform: PlatformId): PlatformStatus {
  if (!isImplemented(platform)) {
    return {
      platform,
      available: false,
      reason: "not_built",
      message: "Not available yet",
    };
  }
  if (!platformFlags[platform]()) {
    return {
      platform,
      available: false,
      reason: "not_configured",
      message: "Needs credentials from an admin",
    };
  }
  return { platform, available: true, reason: "available", message: null };
}

export function allPlatformStatuses(): PlatformStatus[] {
  return PLATFORMS.map(platformStatus);
}

/**
 * Get an adapter for publishing.
 *
 * Throws a clear, user-facing error when the platform is not usable, so the
 * worker records a permanent failure with an actionable message rather than a
 * stack trace.
 */
export function getAdapter(platform: PlatformId): PlatformAdapter {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    throw new ApiError("PLATFORM_DISABLED", `${platform} posting is not available in this build.`);
  }
  if (!platformFlags[platform]()) {
    throw new ApiError(
      "PLATFORM_DISABLED",
      `${platform} is not enabled yet. An admin needs to complete its setup.`,
    );
  }
  return adapter;
}

/** Non-throwing lookup, for validation and preview where absence is expected. */
export function findAdapter(platform: PlatformId): PlatformAdapter | null {
  return ADAPTERS[platform] ?? null;
}
