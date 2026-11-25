"use client";

import type { ComposerMedia } from "./media-picker";

/**
 * What the post will look like on each network.
 *
 * These are approximations, not screenshots, and the UI says so: fonts are the
 * app's, not the platform's, and exact spacing differs. What they are good for
 * is the thing a caption box cannot show — whether the image crops badly, whether
 * a hashtag block makes the caption unreadable, whether the first comment reads
 * as an afterthought.
 *
 * Two rules kept throughout:
 *  - Show the whole caption. A preview that truncates hides exactly the text the
 *    writer needs to proofread.
 *  - Never invent content. If no image is attached, show that platform's "image
 *    required" state rather than a placeholder photo.
 */

export interface PreviewOptions {
  firstComment: string;
  altText: string;
}

export interface PreviewAccount {
  displayName: string;
  handle: string | null;
}

/** Hashtags and mentions are links on every one of these platforms. */
function renderRichText(text: string, platform: "INSTAGRAM" | "FACEBOOK" | "LINKEDIN" | "X") {
  const parts = text.split(/(#[\p{L}\p{N}_]+|@[A-Za-z0-9._]+)/gu);

  return parts.map((part, index) => {
    if (/^#[\p{L}\p{N}_]+$/u.test(part)) {
      // Only Instagram and X colour hashtags; LinkedIn and Facebook render them
      // as plain text, and pretending otherwise would overstate the result.
      const linkable = platform === "INSTAGRAM" || platform === "X";
      return linkable ? (
        <span key={index} className="pv-link">
          {part}
        </span>
      ) : (
        <span key={index}>{part}</span>
      );
    }

    if (/^@[A-Za-z0-9._]+$/.test(part)) {
      return (
        <span key={index} className="pv-link">
          {part}
        </span>
      );
    }

    return <span key={index}>{part}</span>;
  });
}

function initials(name: string): string {
  const cleaned = name.replace(/^@/, "").trim();
  const words = cleaned.split(/[\s._-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? "");
  return (letters.join("") || cleaned.slice(0, 2) || "CW").toUpperCase();
}

function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      className="pv-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/** One media item, or a carousel when several are attached. */
function Media({
  media,
  shape,
  platform,
}: {
  media: ComposerMedia[];
  shape: "square" | "natural" | "wide";
  platform: string;
}) {
  if (media.length === 0) return null;

  const first = media[0]!;
  const extra = media.length - 1;

  return (
    <div className="pv-media" data-shape={shape}>
      {first.kind === "VIDEO" ? (
        first.publicUrl ? (
          <video src={first.publicUrl} className="pv-media-item" controls playsInline />
        ) : (
          <div className="pv-media-item pv-media-empty">Processing video…</div>
        )
      ) : first.publicUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={first.publicUrl} alt="" className="pv-media-item" />
      ) : (
        <div className="pv-media-item pv-media-empty">Image not ready</div>
      )}

      {extra > 0 ? <span className="pv-media-count">1/{media.length}</span> : null}
      {media.length > 1 ? (
        <span className="pv-sr">
          {media.length} items attached to {platform}; the first is shown.
        </span>
      ) : null}
    </div>
  );
}

/** The small grey annotation bar that never appears on the platform itself. */
function Note({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="pv-note">
      <span className="pv-note-label">{label}</span> {children}
    </p>
  );
}

export function PostPreview({
  platform,
  accountName,
  caption,
  media,
  options,
  firstCommentLabel,
  clientName,
}: {
  platform: "INSTAGRAM" | "FACEBOOK" | "LINKEDIN" | "X";
  accountName: string;
  caption: string;
  media: ComposerMedia[];
  options: PreviewOptions;
  firstCommentLabel: string;
  clientName: string;
}) {
  const hasCaption = caption.trim().length > 0;
  const displayName =
    platform === "INSTAGRAM" ? accountName.replace(/^@/, "") : accountName;
  const handle =
    platform === "INSTAGRAM"
      ? `@${accountName.replace(/^@/, "")}`
      : platform === "X"
        ? accountName.startsWith("@")
          ? accountName
          : `@${accountName}`
        : null;

  return (
    <div className="preview-block">
      <div className={`pv-frame pv-frame-${platform.toLowerCase()}`}>
        <div className="pv-frame-head">
          <span className="pv-frame-platform">{PLATFORM_LABEL[platform]}</span>
          <span className="pv-frame-hint">Approximate preview</span>
        </div>

        {platform === "INSTAGRAM" ? (
          <div className="pv-card">
            <div className="pv-head">
              <Avatar name={displayName} size={34} />
              <div className="pv-head-text">
                <span className="pv-name">{displayName}</span>
                <span className="pv-sub">{clientName}</span>
              </div>
              <span className="pv-more" aria-hidden="true">
                ···
              </span>
            </div>

            {media.length > 0 ? (
              <Media media={media} shape="square" platform="Instagram" />
            ) : (
              <div className="pv-required">
                Instagram needs a photo or video. Nothing will publish until one is attached.
              </div>
            )}

            <div className="pv-actions">
              <span aria-hidden="true">♡</span>
              <span aria-hidden="true">💬</span>
              <span aria-hidden="true">➤</span>
              <span className="pv-actions-end" aria-hidden="true">
                ⌗
              </span>
            </div>

            <div className="pv-body">
              {hasCaption ? (
                <p className="pv-caption">
                  <strong className="pv-name-inline">{displayName}</strong>{" "}
                  {renderRichText(caption, "INSTAGRAM")}
                </p>
              ) : (
                <p className="pv-placeholder">No caption yet.</p>
              )}

              {options.firstComment.trim() ? (
                <p className="pv-caption pv-comment">
                  <strong className="pv-name-inline">{displayName}</strong>{" "}
                  {renderRichText(options.firstComment, "INSTAGRAM")}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {platform === "FACEBOOK" ? (
          <div className="pv-card">
            <div className="pv-head">
              <Avatar name={displayName} size={34} />
              <div className="pv-head-text">
                <span className="pv-name">{displayName}</span>
                <span className="pv-sub">Just now · 🌐</span>
              </div>
              <span className="pv-more" aria-hidden="true">
                ···
              </span>
            </div>

            <div className="pv-body pv-body-first">
              {hasCaption ? (
                <p className="pv-caption">{renderRichText(caption, "FACEBOOK")}</p>
              ) : (
                <p className="pv-placeholder">No caption yet.</p>
              )}
            </div>

            {media.length > 0 ? <Media media={media} shape="natural" platform="Facebook" /> : null}

            <div className="pv-reactions">
              <span aria-hidden="true">👍❤️</span>
              <span className="pv-reactions-end">Like · Comment · Share</span>
            </div>

            {options.firstComment.trim() ? (
              <div className="pv-body pv-comment-block">
                <p className="pv-caption">
                  <strong className="pv-name-inline">{displayName}</strong>{" "}
                  {renderRichText(options.firstComment, "FACEBOOK")}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {platform === "LINKEDIN" ? (
          <div className="pv-card">
            <div className="pv-head">
              <Avatar name={displayName} size={40} />
              <div className="pv-head-text">
                <span className="pv-name">{displayName}</span>
                <span className="pv-sub">Just now · 🌐</span>
              </div>
              <span className="pv-more" aria-hidden="true">
                ···
              </span>
            </div>

            <div className="pv-body pv-body-first">
              {hasCaption ? (
                <p className="pv-caption pv-caption-linkedin">
                  {renderRichText(caption, "LINKEDIN")}
                </p>
              ) : (
                <p className="pv-placeholder">No caption yet.</p>
              )}
            </div>

            {media.length > 0 ? <Media media={media} shape="wide" platform="LinkedIn" /> : null}

            <div className="pv-reactions">
              <span>Like · Comment · Repost · Send</span>
            </div>

            {options.firstComment.trim() ? (
              <div className="pv-body pv-comment-block">
                <p className="pv-caption">
                  <strong className="pv-name-inline">{displayName}</strong>{" "}
                  {renderRichText(options.firstComment, "LINKEDIN")}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {platform === "X" ? (
          <div className="pv-card pv-card-x">
            <div className="pv-head pv-head-x">
              <Avatar name={displayName} size={40} />
              <div className="pv-head-text pv-head-text-x">
                <span className="pv-name">{displayName}</span>
                <span className="pv-sub">{handle} · now</span>
              </div>
              <span className="pv-more" aria-hidden="true">
                ···
              </span>
            </div>

            <div className="pv-body pv-body-first pv-body-x">
              {hasCaption ? (
                <p className="pv-caption pv-caption-x">{renderRichText(caption, "X")}</p>
              ) : (
                <p className="pv-placeholder">Nothing written yet.</p>
              )}
            </div>

            {media.length > 0 ? <Media media={media} shape="wide" platform="X" /> : null}

            <div className="pv-reactions pv-reactions-x">
              <span aria-hidden="true">💬</span>
              <span aria-hidden="true">⇄</span>
              <span aria-hidden="true">♡</span>
              <span aria-hidden="true">📊</span>
            </div>

            {options.firstComment.trim() ? (
              <div className="pv-body pv-comment-block pv-comment-block-x">
                <p className="pv-caption pv-caption-x">
                  <strong className="pv-name-inline">{displayName}</strong>{" "}
                  {renderRichText(options.firstComment, "X")}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Below the frame: the facts the platform does not show but that ship with
          the post. Kept outside the mock so they cannot be mistaken for it. */}
      <div className="pv-annotations">
        {options.altText.trim() ? (
          <Note label="Image description (not shown on the post)">{options.altText.trim()}</Note>
        ) : null}
        {options.firstComment.trim() ? (
          <Note label={firstCommentLabel}>
            Posted straight after the post. It is a separate item, so it can be deleted without
            deleting the post.
          </Note>
        ) : null}
      </div>
    </div>
  );
}

const PLATFORM_LABEL = {
  INSTAGRAM: "Instagram feed",
  FACEBOOK: "Facebook Page",
  LINKEDIN: "LinkedIn feed",
  X: "X timeline",
} as const;
