/**
 * The platform adapter contract.
 *
 * Every social network is implemented behind this interface so that the
 * composer, the worker and the API never branch on a platform name. Adding a
 * platform means adding a folder and registering it — nothing else changes.
 *
 * Rules for implementers:
 *  - Never log, return or throw a token. Errors must be normalised through
 *    `PlatformError` with a safe message.
 *  - Never throw a raw fetch error; classify it (transient / permanent /
 *    ambiguous) so the retry policy can act correctly.
 *  - Report success only when the platform has confirmed it and an id is
 *    available. An optimistic "probably worked" is not success.
 */

import type { PlatformId } from "@/lib/domain";

// ---------------------------------------------------------------------------
// Publishing input
// ---------------------------------------------------------------------------

export interface PublishMedia {
  id: string;
  kind: "IMAGE" | "VIDEO";
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** Private object key in our bucket. Adapters that upload bytes stream from here. */
  storageKey: string;
  /**
   * Publicly reachable URL, required by platforms that fetch media themselves
   * (Meta, Instagram). Null when the public projection has not been made yet,
   * which is a validation error for those platforms.
   */
  publicUrl: string | null;
}

export interface PublishRequest {
  /** Platform post id of nothing yet — this is a fresh publish. */
  targetId: string;
  postId: string;
  platform: PlatformId;

  /** The caption already resolved for this platform (per-target override applied). */
  caption: string;
  /** Links extracted from the caption, for platforms that need them separately. */
  linkUrl: string | null;

  media: PublishMedia[];

  /** Decrypted for the duration of this call only. Never persist or log. */
  accessToken: string;

  /** The platform-side identity: page id, ig user id, member/org urn, x user id. */
  externalId: string;
  accountType: string;

  /** Correlates the attempt row with log lines. */
  requestId: string;

  /** Aborts the request if the worker is shutting down. */
  signal?: AbortSignal;
}

export interface PublishSuccess {
  ok: true;
  /** The id the platform assigned. Required — we do not accept a success without one. */
  platformPostId: string;
  /** A permalink when the platform returns or allows deriving one. */
  platformPostUrl: string | null;
  /** Anything worth recording for diagnostics (never tokens). */
  raw?: Record<string, unknown>;
}

export interface PublishFailure {
  ok: false;
  error: PlatformError;
}

export type PublishResult = PublishSuccess | PublishFailure;

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

/**
 * How the retry policy should treat a failure.
 *
 * - `transient`   network blip, 5xx, rate limit. Retry with backoff.
 * - `permanent`   validation, permission, content policy. Do not retry; a human
 *                 must change the post or the account.
 * - `auth`        token expired or revoked. Try a refresh once, then ask the
 *                 team to reconnect.
 * - `ambiguous`   we cannot tell whether the platform accepted the post (e.g. a
 *                 timeout after sending). Never auto-retry: that is how
 *                 duplicate posts happen.
 */
export type ErrorClass = "transient" | "permanent" | "auth" | "ambiguous";

export class PlatformError extends Error {
  readonly platform: PlatformId;
  readonly errorClass: ErrorClass;
  readonly code: string;
  readonly httpStatus: number | null;
  /** Safe to show a non-technical team member. Never contains a token. */
  readonly userMessage: string;
  readonly retryAfterSeconds: number | null;

  constructor(params: {
    platform: PlatformId;
    errorClass: ErrorClass;
    code: string;
    message: string;
    userMessage?: string;
    httpStatus?: number | null;
    retryAfterSeconds?: number | null;
  }) {
    super(params.message);
    this.name = "PlatformError";
    this.platform = params.platform;
    this.errorClass = params.errorClass;
    this.code = params.code;
    this.httpStatus = params.httpStatus ?? null;
    this.userMessage = params.userMessage ?? params.message;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
  }

  toRecord(): Record<string, unknown> {
    return {
      platform: this.platform,
      errorClass: this.errorClass,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  code: string;
  message: string;
  field?: "caption" | "media" | "account";
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Characters remaining, when the platform has a caption limit. */
  remainingChars?: number;
}

export interface ValidationInput {
  caption: string;
  media: Pick<PublishMedia, "kind" | "mimeType" | "byteSize" | "width" | "height" | "durationSeconds" | "publicUrl">[];
  accountType: string;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface PlatformCapabilities {
  platform: PlatformId;
  /** Null when the platform imposes no hard limit. */
  captionLimit: number | null;
  /** Whether the platform requires a media item on every post. */
  requiresMedia: boolean;
  supportedImageMimeTypes: readonly string[];
  supportedVideoMimeTypes: readonly string[];
  maxImageBytes: number;
  maxVideoBytes: number;
  maxImages: number;
  maxVideos: number;
  supportsCarousel: boolean;
  /** Whether the platform fetches media from a public URL (Meta, Instagram). */
  requiresPublicMediaUrl: boolean;
  /** Whether the platform charges per post containing a link. */
  linkAffectsCost: boolean;
  supportsNativeScheduling: boolean;
  docsUrl: string;
}

// ---------------------------------------------------------------------------
// Account discovery and tokens
// ---------------------------------------------------------------------------

export interface DiscoveredAccount {
  externalId: string;
  displayName: string;
  accountType: string;
  /** Page access token for Meta, when the discovery step yields one. */
  accessToken?: string;
  tokenExpiresAt?: Date | null;
  scopes?: string[];
  /** Extra platform-specific handle, e.g. an Instagram username. */
  handle?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
  tokenType?: string;
}

export interface RefreshResult {
  ok: boolean;
  tokens?: TokenSet;
  /** Set when the token cannot be refreshed and the team must reconnect. */
  requiresReconnect?: boolean;
  error?: PlatformError;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly capabilities: PlatformCapabilities;

  /**
   * Validate a post for this platform without touching the network.
   * Called by the composer for live feedback and again server-side before
   * anything is enqueued, so a bad target can never reach the worker.
   */
  validate(input: ValidationInput): ValidationResult;

  /**
   * Publish one target. Must resolve (not throw) with a PublishResult, using
   * PlatformError for failures so the retry policy can classify them.
   */
  publish(request: PublishRequest): Promise<PublishResult>;

  /**
   * Exchange a short-lived token for a long-lived one where the platform
   * supports it. Returns the same TokenSet on platforms that do not.
   */
  exchangeForLongLived?(tokens: TokenSet): Promise<TokenSet>;

  /** Refresh an expired token. Adapters that cannot must say so explicitly. */
  refresh?(refreshToken: string): Promise<RefreshResult>;

  /**
   * Check that a token is still valid, and return the scopes actually granted.
   * Used by the "Verify" action and by the pre-publish expiry check.
   */
  verify?(accessToken: string, externalId: string): Promise<{
    ok: boolean;
    scopes?: string[];
    expiresAt?: Date | null;
    error?: PlatformError;
  }>;

  /**
   * Platform-specific remaining-quota check, when the platform exposes one.
   * Instagram does (100 posts / 24h); others do not.
   */
  getPublishingQuota?(accessToken: string, externalId: string): Promise<{
    used?: number;
    limit?: number;
    remaining?: number;
  } | null>;

  /** Build the OAuth authorize URL. Implemented by adapters, used by the route. */
  buildAuthorizeUrl(params: {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
  }): string;

  /** Exchange an authorization code for tokens. */
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{ ok: true; tokens: TokenSet } | { ok: false; error: PlatformError }>;

  /** List the accounts this token can publish as, with the team choosing later. */
  listAccounts(tokens: TokenSet): Promise<{ ok: true; accounts: DiscoveredAccount[] } | { ok: false; error: PlatformError }>;
}

// ---------------------------------------------------------------------------
// Content rules shared by more than one platform
// ---------------------------------------------------------------------------

/** Counts characters the way X does: every URL collapses to a fixed length. */
export function countXCharacters(text: string): number {
  const urlPattern = /https?:\/\/\S+/g;
  const withoutUrls = text.replace(urlPattern, "");
  const urlCount = (text.match(urlPattern) ?? []).length;
  // X counts each URL as 23 characters regardless of real length.
  // Emoji and most non-Latin scripts count as 2; this approximation counts code
  // points and doubles anything outside the basic multilingual plane.
  const textLength = Array.from(withoutUrls).reduce((sum, char) => {
    const code = char.codePointAt(0) ?? 0;
    return sum + (code > 0xffff ? 2 : 1);
  }, 0);
  return textLength + urlCount * 23;
}
