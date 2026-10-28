/**
 * Meta / Facebook Page adapter.
 *
 * Verified against the Pages API documentation on 2026-10-28 (Graph v26.0):
 *   - Text and link posts: POST /{page-id}/feed with `message` and optional `link`
 *   - Photos:              POST /{page-id}/photos with a publicly reachable `url`
 *   - Permissions:         pages_manage_posts, pages_read_engagement,
 *                          pages_manage_engagement
 *
 * We do NOT use Meta's native scheduling. Our queue owns scheduling so that all
 * four platforms behave identically; relying on `scheduled_publish_time` would
 * give Facebook a different retry and cancellation story from the rest.
 */

import { env } from "@/lib/env";
import { PlatformError, type DiscoveredAccount, type PlatformAdapter, type PublishRequest, type PublishResult, type TokenSet, type ValidationInput, type ValidationResult } from "../types";
import { CAPABILITIES } from "../capabilities";
import { platformRequest, withQuery } from "../http";
import { resultFromIssues, validateCommon } from "../validation";
import { findLinks } from "../capabilities";

const GRAPH_HOST = "https://graph.facebook.com";

function graphUrl(version: string, path: string): string {
  return `${GRAPH_HOST}/${version}/${path}`;
}

export class FacebookAdapter implements PlatformAdapter {
  readonly platform = "FACEBOOK" as const;
  readonly capabilities = CAPABILITIES.FACEBOOK!;

  validate(input: ValidationInput): ValidationResult {
    return resultFromIssues("FACEBOOK", validateCommon("FACEBOOK", input), input.caption);
  }

  buildAuthorizeUrl(params: { state: string; redirectUri: string; codeChallenge?: string }): string {
    const appId = env().META_APP_ID;
    if (!appId) {
      throw new PlatformError({
        platform: "FACEBOOK",
        errorClass: "permanent",
        code: "NOT_CONFIGURED",
        message: "META_APP_ID is not configured.",
        userMessage: "Facebook is not configured yet. An admin needs to add the Meta app credentials.",
      });
    }

    // One consent covers Pages and the linked Instagram account, which is why
    // this build uses Facebook Login rather than a separate Instagram login.
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
      client_id: appId,
      redirect_uri: params.redirectUri,
      state: params.state,
      response_type: "code",
      scope: scopes.join(","),
    });
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{ ok: true; tokens: TokenSet } | { ok: false; error: PlatformError }> {
    try {
      const response = await platformRequest({
        platform: "FACEBOOK",
        url: withQuery(`${GRAPH_HOST}/${env().META_GRAPH_VERSION}/oauth/access_token`, {
          client_id: env().META_APP_ID,
          client_secret: env().META_APP_SECRET,
          redirect_uri: params.redirectUri,
          code: params.code,
        }),
        requestId: "oauth-exchange",
      });

      const body = response.json as { access_token?: string; expires_in?: number };
      if (!body?.access_token) {
        throw new PlatformError({
          platform: "FACEBOOK",
          errorClass: "permanent",
          code: "NO_TOKEN",
          message: "Meta did not return an access token.",
          userMessage: "Facebook did not return an access token. Try connecting again.",
        });
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
      return { ok: false, error: asPlatformError(error) };
    }
  }

  /**
   * Exchange a short-lived user token for a long-lived one.
   *
   * This matters for a scheduler: a short-lived token dies in about an hour,
   * while a long-lived user token lasts ~60 days and the Page tokens derived
   * from it do not expire at all.
   */
  async exchangeForLongLived(tokens: TokenSet): Promise<TokenSet> {
    const response = await platformRequest({
      platform: "FACEBOOK",
      url: withQuery(`${GRAPH_HOST}/${env().META_GRAPH_VERSION}/oauth/access_token`, {
        grant_type: "fb_exchange_token",
        client_id: env().META_APP_ID,
        client_secret: env().META_APP_SECRET,
        fb_exchange_token: tokens.accessToken,
      }),
      requestId: "oauth-long-lived",
    });

    const body = response.json as { access_token?: string; expires_in?: number };
    if (!body?.access_token) return tokens;

    return {
      ...tokens,
      accessToken: body.access_token,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    };
  }

  /**
   * List the Pages this user can publish to, and the Instagram professional
   * account linked to each Page, if any.
   *
   * Instagram is surfaced here because publishing to it needs the Page's own
   * access token — the user token is not sufficient for `instagram_content_publish`
   * when the account is Page-linked.
   */
  async listAccounts(
    tokens: TokenSet,
  ): Promise<{ ok: true; accounts: DiscoveredAccount[] } | { ok: false; error: PlatformError }> {
    try {
      const response = await platformRequest({
        platform: "FACEBOOK",
        url: withQuery(`${GRAPH_HOST}/${env().META_GRAPH_VERSION}/me/accounts`, {
          access_token: tokens.accessToken,
          fields: "id,name,access_token,tasks,instagram_business_account{id,username,name}",
          limit: 100,
        }),
        requestId: "oauth-list-pages",
      });

      const body = response.json as {
        data?: Array<{
          id?: string;
          name?: string;
          access_token?: string;
          tasks?: string[];
          instagram_business_account?: { id?: string; username?: string; name?: string };
        }>;
      };

      const accounts: DiscoveredAccount[] = [];

      for (const page of body.data ?? []) {
        if (!page.id || !page.access_token) continue;

        // Only Pages where the user can actually create content.
        const canPost = (page.tasks ?? []).some((task) =>
          ["CREATE_CONTENT", "MANAGE", "MODERATE"].includes(task),
        );
        if (!canPost) continue;

        accounts.push({
          externalId: page.id,
          displayName: page.name ?? page.id,
          accountType: "PAGE",
          // The Page token is what the adapter publishes with.
          accessToken: page.access_token,
          // Page tokens derived from a long-lived user token do not expire.
          tokenExpiresAt: null,
          scopes: (page.tasks ?? []).map((t) => `page_task:${t}`),
        });

        const ig = page.instagram_business_account;
        if (ig?.id) {
          accounts.push({
            externalId: ig.id,
            displayName: ig.username ? `@${ig.username}` : (ig.name ?? ig.id),
            accountType: "IG_PROFESSIONAL",
            accessToken: page.access_token,
            tokenExpiresAt: null,
            handle: ig.username,
          });
        }
      }

      return { ok: true, accounts };
    } catch (error) {
      return { ok: false, error: asPlatformError(error) };
    }
  }

  async verify(
    accessToken: string,
    externalId: string,
  ): Promise<{ ok: boolean; scopes?: string[]; expiresAt?: Date | null; error?: PlatformError }> {
    try {
      // A cheap read of the Page itself proves the token still works.
      await platformRequest({
        platform: "FACEBOOK",
        url: withQuery(graphUrl(env().META_GRAPH_VERSION, externalId), {
          fields: "id,name",
        }),
        accessToken,
        requestId: "verify",
      });

      return { ok: true, expiresAt: null };
    } catch (error) {
      return { ok: false, error: asPlatformError(error) };
    }
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const version = env().META_GRAPH_VERSION;
    const caption = request.caption;

    try {
      const images = request.media.filter((m) => m.kind === "IMAGE");
      const videos = request.media.filter((m) => m.kind === "VIDEO");

      // Video has its own flow and needs the publish_video permission, which is
      // a separate App Review item. Refuse clearly rather than failing obscurely
      // inside the Graph API.
      if (videos.length > 0) {
        throw new PlatformError({
          platform: "FACEBOOK",
          errorClass: "permanent",
          code: "VIDEO_NOT_ENABLED",
          message: "Facebook video publishing is not enabled in this build.",
          userMessage:
            "Facebook video posts are not enabled yet. Publish an image or text post, or ask an admin to enable video.",
        });
      }

      // Single photo post: Meta fetches the image from a public URL.
      if (images.length === 1) {
        const image = images[0]!;
        if (!image.publicUrl) {
          throw new PlatformError({
            platform: "FACEBOOK",
            errorClass: "permanent",
            code: "MEDIA_NOT_PUBLIC",
            message: "Photo publishing requires a public media URL.",
            userMessage: "This image needs to be re-uploaded before it can go to Facebook.",
          });
        }

        const response = await platformRequest({
          platform: "FACEBOOK",
          url: graphUrl(version, `${request.externalId}/photos`),
          method: "POST",
          body: {
            url: image.publicUrl,
            caption,
            access_token: request.accessToken,
          },
          requestId: request.requestId,
          isPublish: true,
          signal: request.signal,
        });

        const body = response.json as { id?: string; post_id?: string };
        const postId = body.post_id ?? body.id;

        if (!postId) {
          throw new PlatformError({
            platform: "FACEBOOK",
            errorClass: "ambiguous",
            code: "NO_POST_ID",
            message: "Meta accepted the photo but returned no post id.",
            userMessage:
              "Facebook did not confirm the post. Check the Page before retrying.",
          });
        }

        return {
          ok: true,
          platformPostId: postId,
          platformPostUrl: `https://www.facebook.com/${postId}`,
          raw: { photoId: body.id, postId },
        };
      }

      // Text or link post. A link in the caption is passed as the `link`
      // parameter so Facebook renders a preview card instead of a bare URL.
      const links = findLinks(caption);
      const link = links[0];

      const response = await platformRequest({
        platform: "FACEBOOK",
        url: graphUrl(version, `${request.externalId}/feed`),
        method: "POST",
        body: {
          message: caption,
          ...(link ? { link } : {}),
          published: "true",
          access_token: request.accessToken,
        },
        requestId: request.requestId,
        isPublish: true,
        signal: request.signal,
      });

      const body = response.json as { id?: string };
      if (!body.id) {
        throw new PlatformError({
          platform: "FACEBOOK",
          errorClass: "ambiguous",
          code: "NO_POST_ID",
          message: "Meta accepted the post but returned no id.",
          userMessage: "Facebook did not confirm the post. Check the Page before retrying.",
        });
      }

      return {
        ok: true,
        platformPostId: body.id,
        platformPostUrl: `https://www.facebook.com/${body.id}`,
      };
    } catch (error) {
      return { ok: false, error: asPlatformError(error) };
    }
  }
}

export function asPlatformError(error: unknown, platform: "FACEBOOK" = "FACEBOOK"): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError({
    platform,
    errorClass: "permanent",
    code: "UNEXPECTED",
    message: error instanceof Error ? error.message : "Unknown error",
    userMessage: "Something unexpected happened while contacting the platform.",
  });
}

export const facebookAdapter = new FacebookAdapter();
