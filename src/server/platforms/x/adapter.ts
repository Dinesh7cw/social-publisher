/**
 * X adapter.
 *
 * Verified 2026-10-28. Endpoints and constraints:
 *   - POST https://api.x.com/2/tweets  with { text }
 *   - OAuth 2.0 Authorization Code with PKCE
 *   - Scopes: tweet.read tweet.write users.read media.write offline.access
 *   - Media: separate v2 upload endpoint
 *
 * Two facts that decide the design:
 *
 * 1. `offline.access` is mandatory. X access tokens last ~2 hours. A scheduler
 *    that stores a token at connect time and publishes six hours later fails
 *    every single time without a refresh token.
 *
 * 2. Pricing is pay-per-use, and a post containing a URL costs far more than a
 *    plain text post (roughly $0.20 against $0.015 at the time of writing). The
 *    adapter does not decide policy, but it reports `linkAffectsCost` so the
 *    composer can warn and the history can be reconciled.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  PlatformError,
  countXCharacters,
  type AppCredentials,
  type CommentRequest,
  type DeletePublishedRequest,
  type DeleteResult,
  type PlatformAdapter,
  type PublishRequest,
  type PublishResult,
  type TokenSet,
  type DiscoveredAccount,
  type ValidationInput,
  type ValidationResult,
  type RefreshResult,
} from "../types";
import { CAPABILITIES, findLinks } from "../capabilities";
import { platformRequest, withQuery } from "../http";
import { resultFromIssues, validateCommon } from "../validation";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const TWEETS_URL = "https://api.x.com/2/tweets";
const MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";
const USERS_ME_URL = "https://api.x.com/2/users/me";

const SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];

/** PKCE helpers. The verifier is generated per flow and never persisted in plaintext. */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export class XAdapter implements PlatformAdapter {
  readonly platform = "X" as const;
  readonly capabilities = CAPABILITIES.X!;

  validate(input: ValidationInput): ValidationResult {
    const issues = validateCommon("X", input);

    // X counts characters differently from every other platform: every URL is
    // 23 characters regardless of its real length, and emoji count as 2.
    const used = countXCharacters(input.caption);
    const limit = this.capabilities.captionLimit ?? 280;

    if (used > limit) {
      // Replace the generic caption error with X's own arithmetic so the number
      // in the message matches what X will actually count.
      const filtered = issues.filter((i) => i.code !== "CAPTION_TOO_LONG");
      filtered.push({
        code: "CAPTION_TOO_LONG",
        field: "caption",
        message: `This post is ${used} characters as X counts it (links count as 23). X allows ${limit}.`,
      });
      return resultFromIssues("X", filtered, input.caption);
    }

    return resultFromIssues("X", issues, input.caption);
  }

  buildAuthorizeUrl(params: {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
    credentials: AppCredentials;
  }): string {
    if (!params.codeChallenge) {
      throw new PlatformError({
        platform: "X",
        errorClass: "permanent",
        code: "PKCE_REQUIRED",
        message: "X requires a PKCE code challenge.",
        userMessage: "Could not start the X connection. Try again.",
      });
    }

    return withQuery(AUTHORIZE_URL, {
      response_type: "code",
      client_id: params.credentials.appId,
      redirect_uri: params.redirectUri,
      scope: SCOPES.join(" "),
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    });
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    credentials: AppCredentials;
  }): Promise<{ ok: true; tokens: TokenSet } | { ok: false; error: PlatformError }> {
    if (!params.codeVerifier) {
      return {
        ok: false,
        error: new PlatformError({
          platform: "X",
          errorClass: "permanent",
          code: "PKCE_REQUIRED",
          message: "Missing PKCE verifier for the token exchange.",
          userMessage: "Could not complete the X connection. Try again.",
        }),
      };
    }

    try {
      const response = await platformRequest({
        platform: "X",
        url: TOKEN_URL,
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: params.code,
          redirect_uri: params.redirectUri,
          client_id: params.credentials.appId,
          code_verifier: params.codeVerifier,
        }),
        requestId: "oauth-exchange-x",
      });

      const body = response.json as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };

      if (!body?.access_token) {
        return {
          ok: false,
          error: new PlatformError({
            platform: "X",
            errorClass: "permanent",
            code: "NO_TOKEN",
            message: "X did not return an access token.",
            userMessage: "X did not return an access token. Try connecting again.",
          }),
        };
      }

      if (!body.refresh_token) {
        // Without a refresh token this account can only publish for ~2 hours.
        // Better to say so now than to fail silently on the first scheduled post.
        return {
          ok: false,
          error: new PlatformError({
            platform: "X",
            errorClass: "permanent",
            code: "NO_REFRESH_TOKEN",
            message: "X did not return a refresh token despite requesting offline.access.",
            userMessage:
              "X did not grant long-term access, so scheduled posts would fail. Check that this app is set up as a Web App in the X developer portal, then try again.",
          }),
        };
      }

      return {
        ok: true,
        tokens: {
          accessToken: body.access_token,
          refreshToken: body.refresh_token,
          expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
          scopes: body.scope ? body.scope.split(" ").filter(Boolean) : SCOPES,
          tokenType: "Bearer",
        },
      };
    } catch (error) {
      return { ok: false, error: asXError(error) };
    }
  }

  async refresh(refreshToken: string, credentials: AppCredentials): Promise<RefreshResult> {
    try {
      const response = await platformRequest({
        platform: "X",
        url: TOKEN_URL,
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: credentials.appId,
        }),
        requestId: "oauth-refresh-x",
      });

      const body = response.json as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };

      if (!body?.access_token) {
        return {
          ok: false,
          requiresReconnect: true,
          error: new PlatformError({
            platform: "X",
            errorClass: "auth",
            code: "REFRESH_FAILED",
            message: "X did not return a refreshed access token.",
            userMessage: "X needs to be reconnected.",
          }),
        };
      }

      return {
        ok: true,
        tokens: {
          accessToken: body.access_token,
          // X rotates the refresh token; keep the new one or the next refresh
          // will fail.
          refreshToken: body.refresh_token ?? refreshToken,
          expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
          scopes: body.scope ? body.scope.split(" ").filter(Boolean) : undefined,
        },
      };
    } catch (error) {
      const platformError = asXError(error);
      return {
        ok: false,
        requiresReconnect: platformError.errorClass === "auth" || platformError.httpStatus === 400,
        error: platformError,
      };
    }
  }

  async listAccounts(
    tokens: TokenSet,
  ): Promise<{ ok: true; accounts: DiscoveredAccount[] } | { ok: false; error: PlatformError }> {
    try {
      const response = await platformRequest({
        platform: "X",
        url: withQuery(USERS_ME_URL, { "user.fields": "username,name,profile_image_url" }),
        accessToken: tokens.accessToken,
        requestId: "x-me",
      });

      const body = response.json as {
        data?: { id?: string; username?: string; name?: string };
      };

      if (!body.data?.id) {
        return {
          ok: false,
          error: new PlatformError({
            platform: "X",
            errorClass: "permanent",
            code: "NO_USER",
            message: "X did not return a user for this token.",
            userMessage: "Could not read the X account. Try connecting again.",
          }),
        };
      }

      return {
        ok: true,
        accounts: [
          {
            externalId: body.data.id,
            displayName: body.data.username ? `@${body.data.username}` : (body.data.name ?? body.data.id),
            accountType: "X_ACCOUNT",
            accessToken: tokens.accessToken,
            tokenExpiresAt: tokens.expiresAt ?? null,
            scopes: tokens.scopes,
            handle: body.data.username,
          },
        ],
      };
    } catch (error) {
      return { ok: false, error: asXError(error) };
    }
  }

  async verify(
    accessToken: string,
    _externalId: string,
  ): Promise<{ ok: boolean; scopes?: string[]; expiresAt?: Date | null; error?: PlatformError }> {
    try {
      await platformRequest({
        platform: "X",
        url: USERS_ME_URL,
        accessToken,
        requestId: "verify-x",
      });
      return { ok: true, expiresAt: null };
    } catch (error) {
      return { ok: false, error: asXError(error) };
    }
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    try {
      const images = request.media.filter((m) => m.kind === "IMAGE");
      const videos = request.media.filter((m) => m.kind === "VIDEO");

      if (videos.length > 0) {
        // X video needs chunked upload and longer processing; out of scope for
        // the MVP and refused explicitly rather than half-implemented.
        throw new PlatformError({
          platform: "X",
          errorClass: "permanent",
          code: "VIDEO_NOT_ENABLED",
          message: "X video publishing is not enabled in this build.",
          userMessage: "X video posts are not enabled yet. Publish an image or text post instead.",
        });
      }

      // --- Upload media, collecting media ids ------------------------------
      const mediaIds: string[] = [];
      for (const image of images) {
        const mediaId = await this.uploadMedia(request, image.publicUrl);
        mediaIds.push(mediaId);
      }

      // --- Create the post -------------------------------------------------
      const body: Record<string, unknown> = { text: request.caption };
      if (mediaIds.length > 0) {
        body.media = { media_ids: mediaIds };
      }
      if (request.options?.replySettings) {
        body.reply_settings = request.options.replySettings;
      }

      const links = findLinks(request.caption);
      if (links.length > 0) {
        // Not an error, but worth recording: this post costs materially more
        // than a plain one under X's pay-per-use pricing.
        console.info("[x] publishing a post containing a URL", {
          requestId: request.requestId,
          linkCount: links.length,
        });
      }

      const response = await platformRequest({
        platform: "X",
        url: TWEETS_URL,
        method: "POST",
        accessToken: request.accessToken,
        headers: { "Content-Type": "application/json" },
        body,
        requestId: request.requestId,
        isPublish: true,
        signal: request.signal,
      });

      const published = response.json as { data?: { id?: string } };
      const tweetId = published.data?.id;

      if (!tweetId) {
        throw new PlatformError({
          platform: "X",
          errorClass: "ambiguous",
          code: "NO_TWEET_ID",
          message: "X returned a successful status without a post id.",
          userMessage: "X did not confirm the post. Check the account before retrying.",
        });
      }

      return {
        ok: true,
        platformPostId: tweetId,
        platformPostUrl: `https://x.com/i/web/status/${tweetId}`,
      };
    } catch (error) {
      return { ok: false, error: asXError(error) };
    }
  }

  /**
   * Delete a post.
   *
   * `DELETE /2/tweets/:id`. OAuth 2.0 user-context tokens with `tweet.write`
   * cover this; an app-only bearer token cannot delete anything.
   */
  async deletePublished(request: DeletePublishedRequest): Promise<DeleteResult> {
    try {
      const response = await platformRequest({
        platform: "X",
        url: `${TWEETS_URL}/${encodeURIComponent(request.platformPostId)}`,
        method: "DELETE",
        accessToken: request.accessToken,
        requestId: request.requestId,
        signal: request.signal,
      });

      const body = response.json as { data?: { deleted?: boolean } } | null;
      if (body?.data && body.data.deleted === false) {
        throw new PlatformError({
          platform: "X",
          errorClass: "permanent",
          code: "DELETE_REFUSED",
          message: "X accepted the delete call but reported deleted:false.",
          userMessage: "X refused to delete this post. Delete it on x.com instead.",
        });
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, error: asXError(error) };
    }
  }

  /**
   * First comment, as a reply to our own post.
   *
   * A reply is a new post on X, which is why the composer labels it that way
   * rather than calling it a comment.
   */
  async commentOnPost(request: CommentRequest): Promise<{ ok: boolean; error?: PlatformError }> {
    try {
      await platformRequest({
        platform: "X",
        url: TWEETS_URL,
        method: "POST",
        accessToken: request.accessToken,
        headers: { "Content-Type": "application/json" },
        body: { text: request.body, reply: { in_reply_to_tweet_id: request.platformPostId } },
        requestId: request.requestId,
        signal: request.signal,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: asXError(error) };
    }
  }

  /**
   * Upload one image and return its media id.
   *
   * X accepts a URL for simple uploads, which avoids streaming bytes through the
   * worker. Media is already on our public projection for Meta/Instagram, so the
   * same file serves here.
   */
  private async uploadMedia(request: PublishRequest, publicUrl: string | null): Promise<string> {
    if (!publicUrl) {
      throw new PlatformError({
        platform: "X",
        errorClass: "permanent",
        code: "MEDIA_UNAVAILABLE",
        message: "Media has no public URL.",
        userMessage: "This image needs to be re-uploaded before it can go to X.",
      });
    }

    const response = await platformRequest({
      platform: "X",
      url: `${MEDIA_UPLOAD_URL}?media_category=tweet_image`,
      method: "POST",
      accessToken: request.accessToken,
      headers: { "Content-Type": "application/json" },
      body: { url: publicUrl, media_category: "tweet_image" },
      requestId: request.requestId,
      signal: request.signal,
    });

    const body = response.json as { data?: { id?: string }; id?: string };
    const mediaId = body.data?.id ?? body.id;

    if (!mediaId) {
      throw new PlatformError({
        platform: "X",
        errorClass: "transient",
        code: "MEDIA_UPLOAD_FAILED",
        message: "X did not return a media id for the uploaded image.",
        userMessage: "Uploading the image to X failed. It will be retried.",
      });
    }

    return mediaId;
  }
}

function asXError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError({
    platform: "X",
    errorClass: "permanent",
    code: "UNEXPECTED",
    message: error instanceof Error ? error.message : "Unknown error",
    userMessage: "Something unexpected happened while contacting X.",
  });
}

export const xAdapter = new XAdapter();
