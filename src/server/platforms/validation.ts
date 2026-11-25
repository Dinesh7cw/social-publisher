/**
 * Validation shared by every adapter.
 *
 * Each adapter calls these then adds its own platform-specific rules. Keeping
 * the generic checks in one place means a limit cannot be enforced differently
 * on the client and the server.
 */

import { capabilitiesFor, findLinks } from "./capabilities";
import type { ValidationInput, ValidationIssue, ValidationResult } from "./types";
import { countXCharacters } from "./types";

/** Human-readable byte size for error messages. */
function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Whether a platform's servers could fetch this URL.
 *
 * Only rules out addresses that are unreachable by construction — loopback,
 * private ranges, link-local, `.local` — so a real domain is never blocked here.
 */
export function isInternetReachable(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  // IPv6 literals only: a hostname like "fdomain.com" must not match.
  if (host.includes(":")) {
    if (host === "::1" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{0,2}:/.test(host)) return false;
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
  }

  return true;
}

/**
 * The checks that apply to every platform.
 *
 * Returns issues rather than throwing so the composer can show all problems at
 * once, per platform.
 */
export function validateCommon(platform: string, input: ValidationInput): ValidationIssue[] {
  const caps = capabilitiesFor(platform);
  const issues: ValidationIssue[] = [];

  const caption = input.caption ?? "";

  if (caps.requiresMedia && input.media.length === 0) {
    issues.push({
      code: "MEDIA_REQUIRED",
      field: "media",
      message: `${caps.platform === "INSTAGRAM" ? "Instagram" : "This platform"} needs at least one image or video.`,
    });
  }

  if (caption.trim().length === 0 && input.media.length === 0) {
    issues.push({
      code: "EMPTY_POST",
      field: "caption",
      message: "Add a caption or media before publishing.",
    });
  }

  // Caption length.
  if (caps.captionLimit !== null) {
    const used = platform === "X" ? countXCharacters(caption) : caption.length;
    if (used > caps.captionLimit) {
      issues.push({
        code: "CAPTION_TOO_LONG",
        field: "caption",
        message: `This caption is ${used.toLocaleString()} characters. ${caps.platform} allows ${caps.captionLimit.toLocaleString()}.`,
      });
    }
  }

  // Media counts and types.
  const images = input.media.filter((m) => m.kind === "IMAGE");
  const videos = input.media.filter((m) => m.kind === "VIDEO");

  if (images.length > caps.maxImages) {
    issues.push({
      code: "TOO_MANY_IMAGES",
      field: "media",
      message: `Attach at most ${caps.maxImages} image${caps.maxImages === 1 ? "" : "s"}.`,
    });
  }

  if (videos.length > caps.maxVideos) {
    issues.push({
      code: "TOO_MANY_VIDEOS",
      field: "media",
      message: `Attach at most ${caps.maxVideos} video${caps.maxVideos === 1 ? "" : "s"}.`,
    });
  }

  if (images.length + videos.length > 1 && !caps.supportsCarousel && input.media.length > 1) {
    issues.push({
      code: "NO_CAROUSEL",
      field: "media",
      message: `${caps.platform} publishes one media item per post. Attach one file.`,
    });
  }

  const unreachable: string[] = [];

  for (const item of input.media) {
    const allowed =
      item.kind === "IMAGE" ? caps.supportedImageMimeTypes : caps.supportedVideoMimeTypes;
    if (!allowed.includes(item.mimeType)) {
      issues.push({
        code: "UNSUPPORTED_MEDIA_TYPE",
        field: "media",
        message: `${caps.platform} does not accept ${item.mimeType}. Allowed: ${allowed.join(", ")}.`,
      });
    }

    const limit = item.kind === "IMAGE" ? caps.maxImageBytes : caps.maxVideoBytes;
    if (item.byteSize > limit) {
      issues.push({
        code: "MEDIA_TOO_LARGE",
        field: "media",
        message: `Each ${item.kind === "IMAGE" ? "image" : "video"} must be under ${mb(limit)} on ${caps.platform}.`,
      });
    }

    // Platforms that fetch the media themselves need a reachable URL. Catching
    // that here avoids a failed publish that the user cannot diagnose.
    if (caps.requiresPublicMediaUrl && !item.publicUrl) {
      issues.push({
        code: "MEDIA_NOT_PUBLIC",
        field: "media",
        message: `${caps.platform} needs to fetch the media from a public URL. Re-upload this file.`,
      });
    } else if (caps.requiresPublicMediaUrl && item.publicUrl && !isInternetReachable(item.publicUrl)) {
      unreachable.push(item.publicUrl);
    }
  }

  // One issue for the whole set: every file shares the same storage host, so
  // repeating the message per image only buries it.
  if (unreachable.length > 0) {
    const host = new URL(unreachable[0]!).host;
    const files = unreachable.length === 1 ? "this file" : `these ${unreachable.length} files`;
    issues.push({
      code: "MEDIA_NOT_REACHABLE",
      field: "media",
      message: `${caps.platform} downloads media from its own servers, and ${host} is only reachable from this machine. Set MEDIA_PUBLIC_BASE_URL to a public address (your live domain or a tunnel) and upload ${files} again.`,
    });
  }

  return issues;
}

/** Wrap a set of issues in the standard result shape. */
export function resultFromIssues(platform: string, issues: ValidationIssue[], caption: string): ValidationResult {
  const caps = capabilitiesFor(platform);
  const used = platform === "X" ? countXCharacters(caption) : caption.length;

  return {
    ok: issues.length === 0,
    issues,
    remainingChars: caps.captionLimit === null ? undefined : caps.captionLimit - used,
  };
}

/**
 * Whether a caption looks like it carries a bare URL. Used only for the cost
 * note on X, where a URL makes a post materially more expensive.
 */
export function hasBareLink(caption: string): boolean {
  return findLinks(caption).length > 0;
}
