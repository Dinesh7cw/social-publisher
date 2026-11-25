/**
 * Platform capability table.
 *
 * One source of truth for what each network accepts. The composer, the
 * server-side validation and the adapters all read from here, so a limit can
 * never be enforced in the UI but forgotten on the server.
 *
 * Every number below was taken from the vendor documentation on 2026-10-28
 * (see docs/PLATFORM-ACCESS.md). Where a figure is an approximation the comment
 * says so; nothing here is guessed silently.
 */

import type { PlatformCapabilities } from "./types";

/** 5 MiB — Facebook's documented photo limit for URL-based uploads. */
const FB_MAX_IMAGE = 5 * 1024 * 1024;

export const CAPABILITIES: Record<string, PlatformCapabilities> = {
  /**
   * Facebook Pages.
   * Text + link posts via /{page-id}/feed, photos via /{page-id}/photos.
   * A Page post has no hard published caption limit, but the composer caps at
   * 63,206 characters, which is Facebook's documented post limit.
   */
  FACEBOOK: {
    platform: "FACEBOOK",
    captionLimit: 63_206,
    requiresMedia: false,
    supportedImageMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    supportedVideoMimeTypes: ["video/mp4", "video/quicktime"],
    maxImageBytes: FB_MAX_IMAGE,
    maxVideoBytes: 1024 * 1024 * 1024,
    maxImages: 10,
    maxVideos: 1,
    supportsCarousel: false,
    requiresPublicMediaUrl: true,
    linkAffectsCost: false,
    supportsNativeScheduling: true,
    supportsDelete: true,
    deleteNote: "Deletes the post from the Page with the Page token.",
    docsUrl: "https://developers.facebook.com/docs/pages-api/posts",
  },

  /**
   * Instagram professional accounts.
   * Two-step publish: /{ig-id}/media then /{ig-id}/media_publish.
   * JPEG only for images. Media must be publicly fetchable by Meta.
   * Carousels: up to 20 items (documented as 20 in the current guide).
   */
  INSTAGRAM: {
    platform: "INSTAGRAM",
    captionLimit: 2_200,
    // Instagram cannot publish a text-only post at all.
    requiresMedia: true,
    supportedImageMimeTypes: ["image/jpeg"],
    supportedVideoMimeTypes: ["video/mp4", "video/quicktime"],
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: 1024 * 1024 * 1024,
    maxImages: 20,
    maxVideos: 10,
    supportsCarousel: true,
    requiresPublicMediaUrl: true,
    linkAffectsCost: false,
    supportsNativeScheduling: false,
    supportsDelete: true,
    // Meta restricts this endpoint to Facebook Login and requires a *user*
    // token with instagram_manage_contents, so it is not the same credential
    // that published the post.
    deleteNote:
      "Delete needs a Facebook user token with instagram_manage_contents. Reconnect the account if this fails.",
    docsUrl: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
  },

  /**
   * LinkedIn.
   * POST https://api.linkedin.com/rest/posts, success is 201 with the id in the
   * x-restli-id response header. Commentary limit is 3,000 characters.
   * Images must be registered through the Images API first.
   */
  LINKEDIN: {
    platform: "LINKEDIN",
    captionLimit: 3_000,
    requiresMedia: false,
    supportedImageMimeTypes: ["image/jpeg", "image/png", "image/gif"],
    supportedVideoMimeTypes: ["video/mp4"],
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 200 * 1024 * 1024,
    maxImages: 20,
    maxVideos: 1,
    supportsCarousel: true,
    requiresPublicMediaUrl: false,
    linkAffectsCost: false,
    supportsNativeScheduling: false,
    supportsDelete: true,
    deleteNote: "Deletes the post through the Posts API with the connected token.",
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
  },

  /**
   * X.
   * 280 characters on the standard endpoint, with every URL counted as a fixed
   * 23 characters. Media uses a separate v2 upload endpoint.
   * Pricing is pay-per-use: a post containing a URL costs materially more than a
   * plain text post, hence linkAffectsCost.
   */
  X: {
    platform: "X",
    captionLimit: 280,
    requiresMedia: false,
    supportedImageMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    supportedVideoMimeTypes: ["video/mp4"],
    maxImageBytes: 5 * 1024 * 1024,
    maxVideoBytes: 512 * 1024 * 1024,
    maxImages: 4,
    maxVideos: 1,
    supportsCarousel: false,
    requiresPublicMediaUrl: false,
    linkAffectsCost: true,
    supportsNativeScheduling: false,
    supportsDelete: true,
    deleteNote: "Deletes the post with DELETE /2/tweets.",
    docsUrl: "https://docs.x.com/x-api/posts/create-post",
  },
};

export function capabilitiesFor(platform: string): PlatformCapabilities {
  const caps = CAPABILITIES[platform];
  if (!caps) throw new Error(`No capabilities defined for platform: ${platform}`);
  return caps;
}

/** Extracts URLs from a caption so cost and link handling can be decided. */
export function findLinks(caption: string): string[] {
  return caption.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
}
