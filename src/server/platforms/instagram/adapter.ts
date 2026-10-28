/**
 * Instagram adapter (Instagram API with Facebook Login).
 *
 * Verified 2026-10-28. Publishing is two steps and there is no shortcut:
 *   1. POST /{ig-id}/media            → creates a container, returns its id
 *   2. POST /{ig-id}/media_publish    → publishes the container, returns media id
 *
 * Constraints that shape this code:
 *   - Media must be on a public server; Meta cURLs the URL itself.
 *   - JPEG only for images. PNG sources are converted at upload time, so by the
 *     time a file reaches here it is already JPEG or it is rejected in the
 *     composer.
 *   - Rate limit: 100 published posts per rolling 24h, enforced at
 *     media_publish. We check the quota first so a scheduled batch fails with a
 *     clear message rather than burning attempts against a hard limit.
 *   - Video containers need time to process; status is polled via
 *     GET /{container-id}?fields=status_code.
 *   - The access token is the *Page's* token for the linked Page.
 */

import { env } from "@/lib/env";
import {
  PlatformError,
  type PlatformAdapter,
  type PublishRequest,
  type PublishResult,
  type TokenSet,
  type DiscoveredAccount,
  type ValidationInput,
  type ValidationResult,
} from "../types";
import { CAPABILITIES } from "../capabilities";
import { platformRequest, withQuery } from "../http";
import { resultFromIssues, validateCommon } from "../validation";

const GRAPH_HOST = "https://graph.facebook.com";
const CONTAINER_POLL_LIMIT = 12; // documented advice: poll once a minute, max 5 min
const CONTAINER_POLL_INTERVAL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InstagramAdapter implements PlatformAdapter {
  readonly platform = "INSTAGRAM" as const;
  readonly capabilities = CAPABILITIES.INSTAGRAM!;

  validate(input: ValidationInput): ValidationResult {
    return resultFromIssues("INSTAGRAM", validateCommon("INSTAGRAM", input), input.caption);
  }

  /**
   * Instagram uses the same Facebook Login consent as Pages. There is no
   * separate authorize URL: the account is discovered through the Page it is
   * linked to, which is why `listAccounts` here returns nothing and the connect
   * flow uses the Facebook adapter's discovery.
   */
  buildAuthorizeUrl(params: { state: string; redirectUri: string; codeChallenge?: string }): string {
    return facebookStyleAuthorize(params.state, params.redirectUri);
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{ ok: true; tokens: TokenSet } | { ok: false; error: PlatformError }> {
    try {
      const response = await platformRequest({
        platform: "INSTAGRAM",
        url: withQuery(`${GRAPH_HOST}/${env().META_GRAPH_VERSION}/oauth/access_token`, {
          client_id: env().META_APP_ID,
          client_secret: env().META_APP_SECRET,
          redirect_uri: params.redirectUri,
          code: params.code,
        }),
        requestId: "oauth-exchange-ig",
      });

      const body = response.json as { access_token?: string; expires_in?: number };
      if (!body?.access_token) {
        return {
          ok: false,
          error: new PlatformError({
            platform: "INSTAGRAM",
            errorClass: "permanent",
            code: "NO_TOKEN",
            message: "Meta did not return an access token.",
            userMessage: "Instagram did not return an access token. Try connecting again.",
          }),
        };
      }

      return {
        ok: true,
        tokens: {
          accessToken: body.access_token,
          expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
          tokenType: "Bearer",
        },
      };
    } catch (error) {
      return { ok: false, error: asInstagramError(error) };
    }
  }

  /**
   * Instagram accounts are discovered through their linked Page, so this
   * returns nothing on its own. The connect flow lists Instagram accounts via
   * the Facebook adapter's page listing, which includes
   * `instagram_business_account` on each page.
   */
  async listAccounts(
    _tokens: TokenSet,
  ): Promise<{ ok: true; accounts: DiscoveredAccount[] } | { ok: false; error: PlatformError }> {
    return { ok: true, accounts: [] };
  }

  async verify(
    accessToken: string,
    externalId: string,
  ): Promise<{ ok: boolean; scopes?: string[]; expiresAt?: Date | null; error?: PlatformError }> {
    try {
      await platformRequest({
        platform: "INSTAGRAM",
        url: withQuery(`${GRAPH_HOST}/${env().META_GRAPH_VERSION}/${externalId}`, {
          fields: "id,username",
        }),
        accessToken,
        requestId: "verify-ig",
      });
      return { ok: true, expiresAt: null };
    } catch (error) {
      return { ok: false, error: asInstagramError(error) };
    }
  }

  /**
   * Current publishing quota for the account.
   *
   * Documented as 100 posts per rolling 24h (carousels count as one). Checking
   * before publishing turns "the 43rd post in a batch silently fails" into "we
   * stopped at the limit with a clear message".
   */
  async getPublishingQuota(
    accessToken: string,
    externalId: string,
  ): Promise<{ used?: number; limit?: number; remaining?: number } | null> {
    try {
      const response = await platformRequest({
        platform: "INSTAGRAM",
        url: withQuery(
          `${GRAPH_HOST}/${env().META_GRAPH_VERSION}/${externalId}/content_publishing_limit`,
          { fields: "quota_usage,config" },
        ),
        accessToken,
        requestId: "quota",
      });

      const body = response.json as {
        data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
      };

      const entry = body.data?.[0];
      if (!entry) return null;

      const used = entry.quota_usage;
      const limit = entry.config?.quota_total;

      return {
        used,
        limit,
        remaining: used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined,
      };
    } catch {
      // Quota is advisory. A failure to read it must not block publishing.
      return null;
    }
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const version = env().META_GRAPH_VERSION;
    const igId = request.externalId;

    try {
      // 1. Quota pre-flight. One request now saves a doomed batch later.
      const quota = await this.getPublishingQuota(request.accessToken, igId);
      if (quota?.remaining !== undefined && quota.remaining <= 0) {
        throw new PlatformError({
          platform: "INSTAGRAM",
          errorClass: "permanent",
          code: "QUOTA_EXHAUSTED",
          message: "Instagram publishing quota for the last 24 hours is exhausted.",
          userMessage:
            "This Instagram account has hit its 24-hour publishing limit. It will be available again within a day.",
        });
      }

      const images = request.media.filter((m) => m.kind === "IMAGE");
      const videos = request.media.filter((m) => m.kind === "VIDEO");

      if (images.length === 0 && videos.length === 0) {
        throw new PlatformError({
          platform: "INSTAGRAM",
          errorClass: "permanent",
          code: "MEDIA_REQUIRED",
          message: "Instagram requires at least one image or video.",
          userMessage: "Instagram cannot publish a text-only post. Attach an image or video.",
        });
      }

      for (const item of request.media) {
        if (!item.publicUrl) {
          throw new PlatformError({
            platform: "INSTAGRAM",
            errorClass: "permanent",
            code: "MEDIA_NOT_PUBLIC",
            message: "Instagram requires media on a publicly reachable URL.",
            userMessage: "This media needs to be re-uploaded before it can go to Instagram.",
          });
        }
      }

      // 2. Build the container. A carousel needs one child container per item,
      //    then a parent container that references them.
      let containerId: string;

      if (request.media.length === 1) {
        containerId = await this.createSingleContainer(request, version);
      } else {
        containerId = await this.createCarouselContainer(request, version);
      }

      // 3. For video, wait until the container is FINISHED before publishing.
      await this.waitForContainerReady(request, containerId, version);

      // 4. Publish the container.
      const publishResponse = await platformRequest({
        platform: "INSTAGRAM",
        url: `${GRAPH_HOST}/${version}/${igId}/media_publish`,
        method: "POST",
        body: {
          creation_id: containerId,
          access_token: request.accessToken,
        },
        requestId: request.requestId,
        isPublish: true,
        signal: request.signal,
      });

      const published = publishResponse.json as { id?: string };
      if (!published.id) {
        throw new PlatformError({
          platform: "INSTAGRAM",
          errorClass: "ambiguous",
          code: "NO_MEDIA_ID",
          message: "Instagram accepted the publish call but returned no media id.",
          userMessage:
            "Instagram did not confirm the post. Check the account before retrying.",
        });
      }

      return {
        ok: true,
        platformPostId: published.id,
        // Instagram has no stable public permalink derivable from the media id
        // without an extra call, so we do not invent one.
        platformPostUrl: null,
      };
    } catch (error) {
      return { ok: false, error: asInstagramError(error) };
    }
  }

  private async createSingleContainer(request: PublishRequest, version: string): Promise<string> {
    const item = request.media[0]!;
    const isVideo = item.kind === "VIDEO";

    const body: Record<string, unknown> = {
      caption: request.caption,
      access_token: request.accessToken,
    };

    if (isVideo) {
      body.media_type = "REELS";
      body.video_url = item.publicUrl;
    } else {
      body.image_url = item.publicUrl;
    }

    const response = await platformRequest({
      platform: "INSTAGRAM",
      url: `${GRAPH_HOST}/${version}/${request.externalId}/media`,
      method: "POST",
      body,
      requestId: request.requestId,
      isPublish: true,
      signal: request.signal,
    });

    const created = response.json as { id?: string };
    if (!created.id) {
      throw new PlatformError({
        platform: "INSTAGRAM",
        errorClass: "ambiguous",
        code: "NO_CONTAINER_ID",
        message: "Instagram did not return a container id.",
        userMessage: "Instagram did not accept the media. Check the account before retrying.",
      });
    }

    return created.id;
  }

  private async createCarouselContainer(request: PublishRequest, version: string): Promise<string> {
    const childIds: string[] = [];

    // Each child is its own container, created without a caption.
    for (const item of request.media) {
      const body: Record<string, unknown> = {
        is_carousel_item: "true",
        access_token: request.accessToken,
      };

      if (item.kind === "VIDEO") {
        body.media_type = "VIDEO";
        body.video_url = item.publicUrl;
      } else {
        body.image_url = item.publicUrl;
      }

      const response = await platformRequest({
        platform: "INSTAGRAM",
        url: `${GRAPH_HOST}/${version}/${request.externalId}/media`,
        method: "POST",
        body,
        requestId: request.requestId,
        isPublish: true,
        signal: request.signal,
      });

      const created = response.json as { id?: string };
      if (!created.id) {
        throw new PlatformError({
          platform: "INSTAGRAM",
          errorClass: "ambiguous",
          code: "NO_CONTAINER_ID",
          message: "Instagram did not return a container id for a carousel item.",
          userMessage: "Instagram did not accept one of the carousel images.",
        });
      }

      childIds.push(created.id);
    }

    // Wait for every child that is a video before creating the parent.
    for (const childId of childIds) {
      await this.waitForContainerReady(request, childId, version);
    }

    const parentResponse = await platformRequest({
      platform: "INSTAGRAM",
      url: `${GRAPH_HOST}/${version}/${request.externalId}/media`,
      method: "POST",
      body: {
        media_type: "CAROUSEL",
        children: childIds.join(","),
        caption: request.caption,
        access_token: request.accessToken,
      },
      requestId: request.requestId,
      isPublish: true,
      signal: request.signal,
    });

    const parent = parentResponse.json as { id?: string };
    if (!parent.id) {
      throw new PlatformError({
        platform: "INSTAGRAM",
        errorClass: "ambiguous",
        code: "NO_CONTAINER_ID",
        message: "Instagram did not return a carousel container id.",
        userMessage: "Instagram did not accept the carousel.",
      });
    }

    return parent.id;
  }

  /**
   * Poll the container until it is FINISHED.
   *
   * Instagram processes video asynchronously; publishing a container that is
   * still IN_PROGRESS fails with a confusing error. Image containers are
   * normally FINISHED immediately, so this returns on the first poll.
   */
  private async waitForContainerReady(
    request: PublishRequest,
    containerId: string,
    version: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < CONTAINER_POLL_LIMIT; attempt += 1) {
      const response = await platformRequest({
        platform: "INSTAGRAM",
        url: withQuery(`${GRAPH_HOST}/${version}/${containerId}`, {
          fields: "status_code,status",
          access_token: request.accessToken,
        }),
        requestId: request.requestId,
        signal: request.signal,
      });

      const body = response.json as { status_code?: string; status?: string };
      const status = body.status_code;

      if (status === "FINISHED" || status === "PUBLISHED") return;

      if (status === "ERROR" || status === "EXPIRED") {
        throw new PlatformError({
          platform: "INSTAGRAM",
          errorClass: "permanent",
          code: `CONTAINER_${status}`,
          message: `Instagram could not process the media (${status}).`,
          userMessage:
            status === "EXPIRED"
              ? "Instagram took too long to process this media. Try publishing again."
              : "Instagram could not process this media. Try a different file.",
        });
      }

      // IN_PROGRESS: wait and poll again.
      await sleep(CONTAINER_POLL_INTERVAL_MS);
    }

    // Still processing after our budget: we must not publish a half-ready
    // container, and we must not call it a failure either (the post does not
    // exist yet, so it is safe to retry).
    throw new PlatformError({
      platform: "INSTAGRAM",
      errorClass: "transient",
      code: "CONTAINER_TIMEOUT",
      message: "Instagram is still processing the media.",
      userMessage: "Instagram is still processing this media. It will be retried.",
    });
  }
}

function facebookStyleAuthorize(state: string, redirectUri: string): string {
  const scopes = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "pages_manage_engagement",
    "instagram_basic",
    "instagram_content_publish",
    "business_management",
  ];

  return withQuery(`${GRAPH_HOST}/${env().META_GRAPH_VERSION}/dialog/oauth`, {
    client_id: env().META_APP_ID,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: scopes.join(","),
  });
}

function asInstagramError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError({
    platform: "INSTAGRAM",
    errorClass: "permanent",
    code: "UNEXPECTED",
    message: error instanceof Error ? error.message : "Unknown error",
    userMessage: "Something unexpected happened while contacting Instagram.",
  });
}

export const instagramAdapter = new InstagramAdapter();
