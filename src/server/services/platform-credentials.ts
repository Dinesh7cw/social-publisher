/**
 * Platform app credentials.
 *
 * What an admin needs before any account can be connected: the app id and app
 * secret of the developer app registered with each network. One app serves the
 * whole agency — it holds the redirect URIs and the approved scopes — so these
 * are deployment settings, not client settings, even though the page that edits
 * them is reached from a client project.
 *
 * Resolution order is database, then environment. The database wins so a
 * deployment can be configured without a restart or a redeploy, and the
 * environment remains the fallback for existing installs that already have the
 * values in .env.
 *
 * A secret is only ever decrypted here, in memory, for the duration of a single
 * token exchange. It is never returned by an API, rendered into a page, or
 * written to a log.
 */

import { encryptSecret, decryptSecret, canDecrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http";
import { PLATFORMS, type PlatformId } from "@/lib/domain";

export type CredentialSource = "saved" | "shared" | "environment";

export interface ResolvedAppCredentials {
  platform: PlatformId;
  appId: string;
  appSecret: string;
  /** Graph or API version, when the platform wants one pinned. */
  config: Record<string, string>;
  source: CredentialSource;
}

/** What each platform's developer console calls the two values. */
export const CREDENTIAL_FIELDS: Record<
  PlatformId,
  {
    appLabel: string;
    appHint: string;
    secretLabel: string;
    secretHint: string;
    consoleUrl: string;
    scopes: string[];
    /** Where to paste the redirect URI in the platform's console. */
    redirectHint: string;
    docs: string;
  }
> = {
  FACEBOOK: {
    appLabel: "Meta app ID",
    appHint: "Meta for Developers → your app → Settings → Basic → App ID.",
    secretLabel: "Meta app secret",
    secretHint: "The same page, revealed with Show. Treat it like a password.",
    consoleUrl: "https://developers.facebook.com/apps",
    scopes: [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_engagement",
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_comments",
      "instagram_manage_contents",
      "business_management",
    ],
    redirectHint:
      "Add the URL above under Facebook Login → Settings → Valid OAuth Redirect URIs.",
    docs: "docs/PLATFORM-ACCESS.md",
  },
  INSTAGRAM: {
    appLabel: "Meta app ID",
    appHint: "Instagram publishing uses the same Meta app as Facebook.",
    secretLabel: "Meta app secret",
    secretHint: "Shared with Facebook; usually already filled in.",
    consoleUrl: "https://developers.facebook.com/apps",
    scopes: [
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_comments",
      "instagram_manage_contents",
      "pages_show_list",
      "business_management",
    ],
    redirectHint:
      "Add the URL above under Facebook Login → Settings → Valid OAuth Redirect URIs.",
    docs: "docs/PLATFORM-ACCESS.md",
  },
  LINKEDIN: {
    appLabel: "LinkedIn client ID",
    appHint: "LinkedIn Developer Portal → your app → Auth → Client ID.",
    secretLabel: "LinkedIn client secret",
    secretHint: "Same page, Primary Client Secret.",
    consoleUrl: "https://www.linkedin.com/developers/apps",
    scopes: ["w_organization_social", "r_organization_social", "rw_organization_admin"],
    redirectHint: "Add the URL above under Auth → Authorized redirect URLs for your app.",
    docs: "docs/PLATFORM-ACCESS.md",
  },
  X: {
    appLabel: "X API key (client ID)",
    appHint: "X Developer Portal → your app → Keys and tokens → OAuth 2.0 Client ID.",
    secretLabel: "X API key secret",
    secretHint: "The OAuth 2.0 Client Secret, not the bearer token.",
    consoleUrl: "https://developer.x.com/en/portal/dashboard",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    redirectHint: "Add the URL above under User authentication settings → Callback URI.",
    docs: "docs/PLATFORM-ACCESS.md",
  },
};

/** The redirect URI to paste into a platform's console. */
export function redirectUriFor(platform: PlatformId): string {
  return `${env().APP_URL}/api/accounts/connect/${platform.toLowerCase()}/callback`;
}

function envFallback(platform: PlatformId): ResolvedAppCredentials | null {
  const config = env();

  if (platform === "FACEBOOK" || platform === "INSTAGRAM") {
    if (!config.META_APP_ID || !config.META_APP_SECRET) return null;
    return {
      platform,
      appId: config.META_APP_ID,
      appSecret: config.META_APP_SECRET,
      config: { version: config.META_GRAPH_VERSION },
      source: "environment",
    };
  }

  if (platform === "LINKEDIN") {
    if (!config.LINKEDIN_CLIENT_ID || !config.LINKEDIN_CLIENT_SECRET) return null;
    return {
      platform,
      appId: config.LINKEDIN_CLIENT_ID,
      appSecret: config.LINKEDIN_CLIENT_SECRET,
      config: { version: config.LINKEDIN_VERSION },
      source: "environment",
    };
  }

  if (!config.X_CLIENT_ID || !config.X_CLIENT_SECRET) return null;
  return {
    platform,
    appId: config.X_CLIENT_ID,
    appSecret: config.X_CLIENT_SECRET,
    config: {},
    source: "environment",
  };
}

/**
 * Platforms that share one developer app.
 *
 * Instagram publishing and deletion run entirely on the Meta app registered for
 * Facebook: same app id, same app secret, same redirect URI, one consent screen.
 * Asking an admin to paste the identical values into a second tab would be busy
 * work that also invites a mismatch, so Instagram borrows Facebook's row.
 */
const SHARES_APP_WITH: Partial<Record<PlatformId, PlatformId>> = {
  INSTAGRAM: "FACEBOOK",
};

async function savedRow(platform: PlatformId) {
  return prisma.platformCredential.findUnique({
    where: { platform },
    select: { appId: true, appSecretCipher: true, config: true },
  });
}

function fromRow(platform: PlatformId, row: {
  appId: string;
  appSecretCipher: string;
  config: unknown;
}, source: CredentialSource): ResolvedAppCredentials {
  const config = (row.config ?? {}) as Record<string, unknown>;
  return {
    platform,
    appId: row.appId,
    appSecret: decryptSecret(row.appSecretCipher),
    config: Object.fromEntries(
      Object.entries(config).map(([key, value]) => [key, String(value)]),
    ),
    source,
  };
}

/**
 * Resolve the credentials to use right now.
 *
 * Returns null when nothing is configured, which callers must treat as "this
 * platform cannot connect" rather than falling back to a guess. A stored row
 * that cannot be decrypted is also a null: the key rotated and nobody re-entered
 * the secret, and pretending otherwise would fail at the network with a worse
 * message.
 *
 * Resolution order: this platform's saved row, then the saved row of the app it
 * shares with (Instagram → Facebook), then the environment.
 */
export async function resolveAppCredentials(
  platform: PlatformId,
): Promise<ResolvedAppCredentials | null> {
  const own = await savedRow(platform);
  if (own && canDecrypt(own.appSecretCipher)) return fromRow(platform, own, "saved");

  const shared = SHARES_APP_WITH[platform];
  if (shared) {
    const parent = await savedRow(shared);
    if (parent && canDecrypt(parent.appSecretCipher)) {
      return fromRow(platform, parent, "shared");
    }
  }

  return envFallback(platform);
}

export async function isPlatformConfigured(platform: PlatformId): Promise<boolean> {
  return (await resolveAppCredentials(platform)) !== null;
}

export interface CredentialStatus {
  platform: PlatformId;
  configured: boolean;
  source: CredentialSource | null;
  /** Never the full secret: enough to recognise a value, not enough to use it. */
  appIdHint: string | null;
  /** True when a saved row exists but cannot be decrypted with the current key. */
  unreadable: boolean;
  /** The platform whose saved app this one borrows, when it shares one. */
  sharedWith: PlatformId | null;
  updatedAt: string | null;
  updatedByName: string | null;
  fields: (typeof CREDENTIAL_FIELDS)[PlatformId];
  redirectUri: string;
}

function maskAppId(appId: string): string {
  if (appId.length <= 6) return "••••";
  return `${appId.slice(0, 4)}…${appId.slice(-4)}`;
}

export async function credentialStatus(platform: PlatformId): Promise<CredentialStatus> {
  const row = await prisma.platformCredential.findUnique({
    where: { platform },
    select: {
      appId: true,
      appSecretCipher: true,
      updatedAt: true,
      updatedBy: { select: { name: true } },
    },
  });

  const resolved = await resolveAppCredentials(platform);
  const unreadable = Boolean(row && !canDecrypt(row.appSecretCipher));

  return {
    platform,
    configured: resolved !== null,
    source: resolved?.source ?? null,
    appIdHint: row ? maskAppId(row.appId) : resolved ? maskAppId(resolved.appId) : null,
    unreadable,
    // Only meaningful when this platform has no row of its own.
    sharedWith: resolved?.source === "shared" ? (SHARES_APP_WITH[platform] ?? null) : null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedByName: row?.updatedBy?.name ?? null,
    fields: CREDENTIAL_FIELDS[platform],
    redirectUri: redirectUriFor(platform),
  };
}

export async function allCredentialStatuses(): Promise<CredentialStatus[]> {
  return Promise.all(PLATFORMS.map((platform) => credentialStatus(platform)));
}

export interface SaveCredentialsInput {
  platform: PlatformId;
  appId: string;
  appSecret: string;
  config?: Record<string, string>;
  actorId: string;
}

/**
 * Save or replace a platform's app credentials.
 *
 * An empty secret is rejected rather than treated as "keep the old one": a form
 * that silently keeps a stale secret is how a rotated key appears saved but is
 * not.
 */
export async function saveAppCredentials(input: SaveCredentialsInput): Promise<void> {
  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();

  if (!appId) throw new ApiError("VALIDATION_FAILED", "The app id is required.");
  if (!appSecret) throw new ApiError("VALIDATION_FAILED", "The app secret is required.");
  if (appSecret.length < 8) {
    throw new ApiError("VALIDATION_FAILED", "That app secret looks too short to be valid.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.platformCredential.upsert({
      where: { platform: input.platform },
      create: {
        platform: input.platform,
        appId,
        appSecretCipher: encryptSecret(appSecret),
        config: input.config ?? {},
        updatedById: input.actorId,
      },
      update: {
        appId,
        appSecretCipher: encryptSecret(appSecret),
        config: input.config ?? {},
        updatedById: input.actorId,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "CREDENTIALS_SAVED",
        entityType: "PlatformCredential",
        entityId: input.platform,
        // Deliberately records only the app id. The secret must not reach an
        // audit row, which is retained far longer than the credential itself.
        metadata: { platform: input.platform, appIdHint: maskAppId(appId) },
      },
    });
  });
}

export async function removeAppCredentials(platform: PlatformId, actorId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.platformCredential.deleteMany({ where: { platform } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "CREDENTIALS_REMOVED",
        entityType: "PlatformCredential",
        entityId: platform,
        metadata: { platform },
      },
    });
  });
}
