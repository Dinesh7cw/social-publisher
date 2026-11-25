"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { PLATFORMS, PLATFORM_SHORT, type PlatformId } from "@/lib/domain";
import { MediaPicker, type ComposerMedia } from "./media-picker";
import { PostPreview } from "./preview";
import "./composer.css";

export interface ComposerAccount {
  id: string;
  platform: PlatformId;
  displayName: string;
  accountType: string;
  status: string;
}

export interface PlatformRules {
  captionLimit: number | null;
  requiresMedia: boolean;
  maxImages: number;
  maxVideos: number;
  imageTypes: readonly string[];
  videoTypes: readonly string[];
  linkAffectsCost: boolean;
  available: boolean;
  unavailableMessage: string | null;
}

/**
 * Per-platform extras, kept separate from the caption because they are not text
 * the audience reads in the post body: a first comment, an image caption for
 * screen readers, who can see or reply.
 */
interface PlatformOptionsState {
  firstComment: string;
  altText: string;
  visibility: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
  replySettings: "everyone" | "following" | "mentioned";
}

function emptyOptions(): PlatformOptionsState {
  return {
    firstComment: "",
    altText: "",
    visibility: "PUBLIC",
    replySettings: "everyone",
  };
}

/** Instagram allows at most 30 hashtags; more makes the whole post fail. */
const INSTAGRAM_HASHTAG_LIMIT = 30;

const HASHTAG_PATTERN = /#[\p{L}\p{N}_]+/gu;

function hashtagsIn(text: string): string[] {
  return text.match(HASHTAG_PATTERN) ?? [];
}

function mentionsIn(text: string): string[] {
  return text.match(/@[A-Za-z0-9._]+/g) ?? [];
}



type Mode = "now" | "schedule" | "draft";

/** A saved draft reopened in the composer. */
export interface ComposerDraft {
  id: string;
  selectedAccountIds: string[];
  captions: Partial<Record<PlatformId, string>>;
  options: Partial<Record<PlatformId, Partial<PlatformOptionsState>>>;
  media: ComposerMedia[];
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  PAGE: "Page",
  IG_PROFESSIONAL: "Professional account",
  MEMBER: "Profile",
  ORGANIZATION: "Company page",
  X_ACCOUNT: "Account",
};

/** X counts every URL as 23 characters whatever its real length. */
function countForX(text: string): number {
  const urlPattern = /https?:\/\/\S+/g;
  const withoutUrls = text.replace(urlPattern, "");
  const urlCount = (text.match(urlPattern) ?? []).length;
  const base = Array.from(withoutUrls).reduce((sum, char) => {
    const code = char.codePointAt(0) ?? 0;
    return sum + (code > 0xffff ? 2 : 1);
  }, 0);
  return base + urlCount * 23;
}

/** The guard the submit button reads. */
function problemsFor(params: {
  platform: PlatformId;
  caption: string;
  rules: PlatformRules | undefined;
  media: ComposerMedia[];
  selectedCount: number;
  options?: PlatformOptionsState;
}): string[] {
  const { platform, caption, rules, media, selectedCount, options } = params;
  const problems: string[] = [];

  if (selectedCount === 0) return [];
  if (!rules) return ["This platform is not configured on this deployment."];

  const used = platform === "X" ? countForX(caption) : caption.length;

  if (rules.captionLimit !== null && used > rules.captionLimit) {
    problems.push(`${used.toLocaleString()} characters, ${PLATFORM_SHORT[platform]} allows ${rules.captionLimit.toLocaleString()}.`);
  }

  // Instagram rejects the whole post over the hashtag cap, so this is a blocker
  // rather than a hint.
  if (platform === "INSTAGRAM") {
    const tagCount = hashtagsIn(caption).length + hashtagsIn(options?.firstComment ?? "").length;
    if (tagCount > INSTAGRAM_HASHTAG_LIMIT) {
      problems.push(
        `${tagCount} hashtags, Instagram allows ${INSTAGRAM_HASHTAG_LIMIT}. Move some to the first comment.`,
      );
    }
  }

  if ((options?.altText ?? "").length > 1000) {
    problems.push("The Instagram image description is limited to 1,000 characters.");
  }

  const images = media.filter((item) => item.kind === "IMAGE");
  const videos = media.filter((item) => item.kind === "VIDEO");

  if (rules.requiresMedia && media.length === 0) {
    problems.push(`${PLATFORM_SHORT[platform]} cannot publish without at least one photo or video.`);
  }
  if (images.length > rules.maxImages) {
    problems.push(`${images.length} images attached; ${PLATFORM_SHORT[platform]} accepts ${rules.maxImages}.`);
  }
  if (videos.length > rules.maxVideos) {
    problems.push(`${videos.length} videos attached; ${PLATFORM_SHORT[platform]} accepts ${rules.maxVideos}.`);
  }

  const unsupported = media.filter((item) =>
    item.kind === "IMAGE"
      ? !rules.imageTypes.includes(item.mimeType)
      : !rules.videoTypes.includes(item.mimeType),
  );
  if (unsupported.length > 0) {
    problems.push(
      `${unsupported.length} attached file${unsupported.length === 1 ? " is" : "s are"} not accepted by ${PLATFORM_SHORT[platform]}.`,
    );
  }

  return problems;
}

export function Composer({
  client,
  accounts,
  rules,
  defaultTimeZone,
  draft,
}: {
  client: { id: string; name: string };
  accounts: ComposerAccount[];
  rules: Record<string, PlatformRules>;
  defaultTimeZone: string;
  /** When set, the composer edits this draft instead of creating a new post. */
  draft?: ComposerDraft;
}) {
  const router = useRouter();

  const accountsByPlatform = useMemo(() => {
    const map = new Map<PlatformId, ComposerAccount[]>();
    for (const platform of PLATFORMS) map.set(platform, []);
    for (const account of accounts) {
      map.get(account.platform)?.push(account);
    }
    return map;
  }, [accounts]);

  const firstUsable = PLATFORMS.find((platform) => (accountsByPlatform.get(platform) ?? []).length > 0);
  const firstDraftPlatform = draft
    ? accounts.find((account) => draft.selectedAccountIds.includes(account.id))?.platform
    : undefined;

  const [activeTab, setActiveTab] = useState<PlatformId>(
    firstDraftPlatform ?? firstUsable ?? "FACEBOOK",
  );
  const [captions, setCaptions] = useState<Partial<Record<PlatformId, string>>>(
    () => draft?.captions ?? {},
  );
  const [options, setOptions] = useState<Partial<Record<PlatformId, PlatformOptionsState>>>(() =>
    Object.fromEntries(
      Object.entries(draft?.options ?? {}).map(([platform, saved]) => [
        platform,
        { ...emptyOptions(), ...saved },
      ]),
    ),
  );
  // An account disconnected since the draft was saved is dropped rather than
  // kept as an invisible selection the writer cannot untick.
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>(() =>
    (draft?.selectedAccountIds ?? []).filter((id) => accounts.some((account) => account.id === id)),
  );
  const [media, setMedia] = useState<ComposerMedia[]>(() => draft?.media ?? []);
  const [mode, setMode] = useState<Mode>("draft");
  /** Write or preview, per platform: proofreading Instagram should not flip X. */
  const [panelMode, setPanelMode] = useState<Partial<Record<PlatformId, "write" | "preview">>>({});
  const [scheduledAt, setScheduledAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Array<{ platform: string; message: string }>>([]);

  const selectedByPlatform = useMemo(() => {
    const map = new Map<PlatformId, ComposerAccount[]>();
    for (const platform of PLATFORMS) map.set(platform, []);
    for (const account of accounts) {
      if (selectedAccounts.includes(account.id)) map.get(account.platform)?.push(account);
    }
    return map;
  }, [accounts, selectedAccounts]);

  const selectedPlatforms = PLATFORMS.filter(
    (platform) => (selectedByPlatform.get(platform) ?? []).length > 0,
  );

  const activeAccounts = accountsByPlatform.get(activeTab) ?? [];
  const activeCaption = captions[activeTab] ?? "";
  const activeRules = rules[activeTab];
  const activeUsed = activeTab === "X" ? countForX(activeCaption) : activeCaption.length;
  const activeLimit = activeRules?.captionLimit ?? null;
  const activeOver = activeLimit !== null && activeUsed > activeLimit;

  // Preview is per platform and opt-in: the default stays the editor, so a
  // writer is never shown a mock where they expected a text box.
  const isPreview = (panelMode[activeTab] ?? "write") === "preview";
  const previewAccountName =
    (selectedByPlatform.get(activeTab) ?? [])[0]?.displayName ??
    activeAccounts[0]?.displayName ??
    client.name;

  /** Never undefined: a platform's extras start from a blank set. */
  const optionsFor = (platform: PlatformId): PlatformOptionsState =>
    options[platform] ?? emptyOptions();

  function updateOptions(platform: PlatformId, patch: Partial<PlatformOptionsState>) {
    setOptions((current) => ({
      ...current,
      [platform]: { ...(current[platform] ?? emptyOptions()), ...patch },
    }));
  }

  /**
   * Instagram's classic workflow: keep the caption readable and push the
   * hashtag block into the first comment. Pulls every #tag out of the caption
   * and appends it to the comment, leaving the prose intact.
   */
  function moveHashtagsToFirstComment(platform: PlatformId) {
    const caption = captions[platform] ?? "";
    const tags = hashtagsIn(caption);
    if (tags.length === 0) return;

    const stripped = caption
      .replace(HASHTAG_PATTERN, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const current = (options[platform] ?? emptyOptions()).firstComment.trim();
    const comment = [current, tags.join(" ")].filter(Boolean).join("\n\n");

    setCaptions((state) => ({ ...state, [platform]: stripped }));
    updateOptions(platform, { firstComment: comment });
  }

  const problemsByPlatform = useMemo(() => {
    const map = new Map<PlatformId, string[]>();
    for (const platform of PLATFORMS) {
      map.set(
        platform,
        problemsFor({
          platform,
          caption: captions[platform] ?? "",
          rules: rules[platform],
          media,
          selectedCount: (selectedByPlatform.get(platform) ?? []).length,
          options: options[platform],
        }),
      );
    }
    return map;
  }, [captions, rules, media, selectedByPlatform, options]);

  const blockingProblems = selectedPlatforms.flatMap((platform) =>
    (problemsByPlatform.get(platform) ?? []).map((message) => ({
      platform: PLATFORM_SHORT[platform],
      message,
    })),
  );

  /**
   * A platform with no credentials on this deployment cannot publish, but the
   * copy can still be written and kept as a draft. So availability blocks
   * publishing, not saving.
   */
  const unavailablePlatforms = selectedPlatforms.filter(
    (platform) => !(rules[platform]?.available ?? false),
  );

  const publishBlockedBySetup = mode !== "draft" && unavailablePlatforms.length > 0;
  const submitBlocked = blockingProblems.length > 0 || publishBlockedBySetup;

  function toggleAccount(accountId: string) {
    setSelectedAccounts((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId],
    );
  }

  function copyActiveCaptionToAll() {
    const text = captions[activeTab] ?? "";
    if (!text.trim()) return;

    setCaptions((current) => {
      const next = { ...current };
      for (const platform of selectedPlatforms) next[platform] = text;
      return next;
    });
  }

  /**
   * Turn one platform's extras into the payload shape the server expects.
   *
   * Only the fields that platform understands are sent: an `altText` on X would
   * be silently ignored, but sending it implies it works, and the adapter would
   * have to defend against it.
   */
  function serializeOptions(platform: PlatformId) {
    const state = optionsFor(platform);

    if (platform === "INSTAGRAM") {
      return {
        firstComment: state.firstComment.trim() || null,
        altText: state.altText.trim() || null,
      };
    }

    if (platform === "FACEBOOK") {
      return { firstComment: state.firstComment.trim() || null };
    }

    if (platform === "LINKEDIN") {
      return {
        firstComment: state.firstComment.trim() || null,
        visibility: state.visibility,
      };
    }

    // X: a "first comment" is really a reply, which is a second post.
    return {
      firstComment: state.firstComment.trim() || null,
      replySettings: state.replySettings,
    };
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);

    if (selectedAccounts.length === 0) {
      setError("Choose at least one account to publish to.");
      return;
    }
    if (mode === "schedule" && !scheduledAt) {
      setError("Choose a date and time to schedule this post.");
      return;
    }
    if (blockingProblems.length > 0) {
      setError("Fix the issues below before this post can go out.");
      setFieldErrors(blockingProblems);
      return;
    }
    if (mode !== "draft" && unavailablePlatforms.length > 0) {
      setError(
        `Publishing to ${unavailablePlatforms
          .map((platform) => PLATFORM_SHORT[platform])
          .join(", ")} is not configured on this deployment yet. Save it as a draft instead.`,
      );
      return;
    }

    setSubmitting(true);

    // The base caption is what surfaces in the calendar and history. Each
    // target still stores its own copy, so this is a label, not the content.
    const baseCaption =
      selectedPlatforms.map((platform) => captions[platform]?.trim()).find((text) => text) ?? "";

    try {
      const targets = selectedAccounts.map((accountId) => {
        const account = accounts.find((item) => item.id === accountId);
        const caption = account ? (captions[account.platform] ?? "").trim() : "";
        return {
          socialAccountId: accountId,
          caption: caption || null,
          options: account ? serializeOptions(account.platform) : null,
        };
      });
      const mediaAssetIds = media.map((item) => item.id);

      const saveResponse = draft
        ? await fetch(`/api/posts/${draft.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Origin: window.location.origin },
            body: JSON.stringify({ baseCaption, mediaAssetIds, targets }),
          })
        : await fetch("/api/posts", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: window.location.origin },
            body: JSON.stringify({ clientId: client.id, baseCaption, mediaAssetIds, targets }),
          });

      if (!saveResponse.ok) {
        const body = (await saveResponse.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? (draft ? "Could not save the draft." : "Could not create the post."));
        setSubmitting(false);
        return;
      }

      const { id } = (await saveResponse.json()) as { id: string };

      // Drafts have no date, so the calendar cannot show them; the overview
      // lists every recent post and is where a draft is reopened from.
      const draftsHref = `/clients/${client.id}`;

      const validateResponse = await fetch(`/api/posts/${id}/validate`, {
        method: "POST",
        headers: { Origin: window.location.origin },
      });

      const validation = (await validateResponse.json()) as {
        ok: boolean;
        results: Array<{
          platform: string;
          ok: boolean;
          accountName: string;
          issues: Array<{ message: string }>;
        }>;
      };

      if (!validation.ok) {
        setFieldErrors(
          validation.results
            .filter((result) => !result.ok)
            .flatMap((result) =>
              result.issues.map((issue) => ({ platform: result.accountName, message: issue.message })),
            ),
        );
        setError("This post cannot publish to every selected account yet. It has been saved as a draft.");

        if (mode === "draft") {
          router.push(draftsHref);
          return;
        }

        setSubmitting(false);
        return;
      }

      if (mode === "schedule") {
        const response = await fetch(`/api/posts/${id}/schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: window.location.origin },
          body: JSON.stringify({
            scheduledAt: new Date(scheduledAt).toISOString(),
            timeZone: defaultTimeZone,
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: { message?: string } }
            | null;
          setError(body?.error?.message ?? "Could not schedule the post.");
          setSubmitting(false);
          return;
        }

        router.push(`/clients/${client.id}/calendar`);
        return;
      }

      if (mode === "now") {
        const response = await fetch(`/api/posts/${id}/publish`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: window.location.origin,
            // One key per submit attempt: a double-click replays instead of
            // publishing twice.
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({}),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: { message?: string } }
            | null;
          setError(body?.error?.message ?? "Could not publish the post.");
          setSubmitting(false);
          return;
        }

        router.push(`/clients/${client.id}/history`);
        return;
      }

      router.push(draftsHref);
    } catch {
      setError("Could not reach the server. Your draft may not have been saved.");
      setSubmitting(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Create post</h1>
            <p className="page-sub">
              Posting as {client.name}. A post needs an account to publish to.
            </p>
          </div>
        </div>

        <div className="empty-state">
          <p className="empty-title">{client.name} has no connected accounts</p>
          <p className="small">
            Connect a Facebook Page, Instagram account, LinkedIn page or X account for this client
            first. Then come back and write one post per platform.
          </p>
          <Link href={`/clients/${client.id}/accounts`} className="btn btn-secondary btn-sm">
            Open connected accounts
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{draft ? "Edit draft" : "Create post"}</h1>
          <p className="page-sub">
            Posting as {client.name}. Each platform below gets its own content, so nothing has to
            be squeezed into one caption.
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit}>
        <div className="composer-grid">
          <div className="composer-main">
            <section className="panel" aria-labelledby="media-title">
              <div className="panel-head">
                <h2 className="panel-title" id="media-title">
                  Photos and video
                </h2>
                <span className="small faint">Shared by every platform you select</span>
              </div>
              <div className="panel-body">
                <MediaPicker
                  clientId={client.id}
                  clientName={client.name}
                  assets={media}
                  onChange={setMedia}
                />
              </div>
            </section>

            <section className="panel platform-panel" aria-labelledby="platform-title">
              <div className="panel-head">
                <h2 className="panel-title" id="platform-title">
                  Content per platform
                </h2>
                <span className="small faint">
                  {selectedPlatforms.length === 0
                    ? "Pick an account to start a platform"
                    : `${selectedPlatforms.length} platform${selectedPlatforms.length === 1 ? "" : "s"} selected`}
                </span>
              </div>

              <div className="platform-tabs" role="tablist" aria-label="Platform">
                {PLATFORMS.map((platform) => {
                  const platformAccounts = accountsByPlatform.get(platform) ?? [];
                  const chosen = (selectedByPlatform.get(platform) ?? []).length;
                  const platformProblems = problemsByPlatform.get(platform) ?? [];
                  const platformRules = rules[platform];
                  const hasAccounts = platformAccounts.length > 0;

                  return (
                    <button
                      key={platform}
                      type="button"
                      role="tab"
                      id={`tab-${platform}`}
                      aria-selected={activeTab === platform}
                      aria-controls={`panel-${platform}`}
                      className="platform-tab"
                      data-active={activeTab === platform ? "true" : "false"}
                      data-empty={!hasAccounts ? "true" : "false"}
                      onClick={() => setActiveTab(platform)}
                    >
                      <span className="platform-tab-name">{PLATFORM_SHORT[platform]}</span>
                      <span className="platform-tab-meta">
                        {!hasAccounts
                          ? "No account"
                          : !platformRules?.available
                            ? "Draft only"
                            : chosen > 0 && platformProblems.length > 0
                              ? "Needs fixing"
                              : chosen > 0
                                ? `${chosen} selected`
                                : `${platformAccounts.length} available`}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div
                className="panel-body platform-panel-body"
                role="tabpanel"
                id={`panel-${activeTab}`}
                aria-labelledby={`tab-${activeTab}`}
              >
                {(() => {
                  const hasAccounts = activeAccounts.length > 0;
                  const chosen = selectedByPlatform.get(activeTab) ?? [];
                  const platformProblems = problemsByPlatform.get(activeTab) ?? [];

                  return (
                    <>
                      <fieldset className="account-list">
                        <legend className="field-label">
                          {PLATFORM_SHORT[activeTab]} accounts for {client.name}
                        </legend>

                        {!hasAccounts ? (
                          <p className="small muted">
                            No {PLATFORM_SHORT[activeTab]} account is connected for this client.{" "}
                            <Link href={`/clients/${client.id}/accounts`}>Connect one</Link> to
                            include this platform.
                          </p>
                        ) : (
                          activeAccounts.map((account) => {
                            const disabled = account.status === "EXPIRED";

                            return (
                              <label
                                key={account.id}
                                className="account-row"
                                data-disabled={disabled ? "true" : "false"}
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedAccounts.includes(account.id)}
                                  onChange={() => toggleAccount(account.id)}
                                  disabled={disabled}
                                />
                                <span className="account-row-main">
                                  <span className="account-row-name">{account.displayName}</span>
                                  <span className="account-row-meta">
                                    {ACCOUNT_TYPE_LABEL[account.accountType] ?? account.accountType}
                                    {account.status === "EXPIRED" ? " · needs reconnecting" : ""}
                                  </span>
                                </span>
                              </label>
                            );
                          })
                        )}
                      </fieldset>

                      {activeRules?.requiresMedia && media.length === 0 ? (
                        <p className="form-banner composer-note">
                          {PLATFORM_SHORT[activeTab]} cannot publish text on its own. Attach a photo
                          or video above.
                        </p>
                      ) : null}

                      {activeRules && !activeRules.available ? (
                        <p className="form-banner composer-note">
                          {PLATFORM_SHORT[activeTab]} cannot be connected yet because its app
                          credentials have not been added.{" "}
                          <Link href={`/clients/${client.id}/credentials`}>
                            Add them under Credentials
                          </Link>{" "}
                          — until then you can still write the content and save this post as a
                          draft.
                        </p>
                      ) : null}

                      {activeTab === "X" && activeRules?.linkAffectsCost ? (
                        <p className="form-banner composer-note">
                          Links count as 23 characters on X, and a post containing a link is charged
                          at a higher rate.
                        </p>
                      ) : null}

                      <div className="panel-switch" role="tablist" aria-label="Editor or preview">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={!isPreview}
                          className="panel-switch-option"
                          data-active={!isPreview}
                          onClick={() =>
                            setPanelMode((current) => ({ ...current, [activeTab]: "write" }))
                          }
                        >
                          Write
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={isPreview}
                          className="panel-switch-option"
                          data-active={isPreview}
                          onClick={() =>
                            setPanelMode((current) => ({ ...current, [activeTab]: "preview" }))
                          }
                        >
                          Preview
                        </button>
                      </div>

                      {isPreview ? (
                        <PostPreview
                          platform={activeTab}
                          accountName={previewAccountName}
                          clientName={client.name}
                          caption={activeCaption}
                          media={media}
                          firstCommentLabel={activeTab === "X" ? "Reply" : "First comment"}
                          options={{
                            firstComment: optionsFor(activeTab).firstComment,
                            altText: optionsFor(activeTab).altText,
                          }}
                        />
                      ) : (
                        <>
                      <div className="field">
                        <div className="caption-head">
                          <label className="field-label" htmlFor={`caption-${activeTab}`}>
                            {PLATFORM_SHORT[activeTab]} content
                          </label>
                          {selectedPlatforms.length > 1 ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={copyActiveCaptionToAll}
                              disabled={activeCaption.trim().length === 0}
                            >
                              Use this text on every selected platform
                            </button>
                          ) : null}
                        </div>

                        <textarea
                          id={`caption-${activeTab}`}
                          className="textarea composer-textarea"
                          value={activeCaption}
                          placeholder={
                            activeTab === "X"
                              ? "Short and direct. 280 characters."
                              : activeTab === "LINKEDIN"
                                ? "What does this mean for the client's audience?"
                                : activeTab === "INSTAGRAM"
                                  ? "The caption people see under the photo or video."
                                  : `What should ${client.name} say here?`
                          }
                          onChange={(event) =>
                            setCaptions((current) => ({ ...current, [activeTab]: event.target.value }))
                          }
                          aria-invalid={activeOver || undefined}
                          aria-describedby={`caption-hint-${activeTab}`}
                        />

                        <span
                          className={activeOver ? "field-error" : "field-hint"}
                          id={`caption-hint-${activeTab}`}
                        >
                          {activeUsed.toLocaleString()}
                          {activeLimit !== null
                            ? ` / ${activeLimit.toLocaleString()}`
                            : " characters"}
                          {activeOver ? " — too long for this platform" : ""}
                          {activeTab === "X" ? " · links count as 23 characters" : ""}
                          {hashtagsIn(activeCaption).length > 0
                            ? ` · ${hashtagsIn(activeCaption).length} hashtag${hashtagsIn(activeCaption).length === 1 ? "" : "s"}`
                            : ""}
                          {mentionsIn(activeCaption).length > 0
                            ? ` · ${mentionsIn(activeCaption).length} mention${mentionsIn(activeCaption).length === 1 ? "" : "s"}`
                            : ""}
                        </span>

                        {/* Empty captions are allowed, but text sitting in the alt
                            text box with nothing here is almost always text
                            meant for the caption. */}
                        {activeTab === "INSTAGRAM" &&
                        activeCaption.trim().length === 0 &&
                        optionsFor("INSTAGRAM").altText.trim().length > 0 ? (
                          <p className="form-banner composer-note" role="status">
                            This post has no caption. The text in Image description is only read
                            by screen readers and is not shown on Instagram. Put the caption here.
                          </p>
                        ) : null}
                      </div>

                      {activeTab === "INSTAGRAM" ? (
                        <InstagramExtras
                          options={optionsFor("INSTAGRAM")}
                          hasImages={media.some((item) => item.kind === "IMAGE")}
                          hashtagCount={hashtagsIn(activeCaption).length}
                          onChange={(patch) => updateOptions("INSTAGRAM", patch)}
                          onMoveHashtags={() => moveHashtagsToFirstComment("INSTAGRAM")}
                        />
                      ) : null}

                      {activeTab === "FACEBOOK" ? (
                        <FirstCommentField
                          platform="FACEBOOK"
                          label="First comment"
                          hint="Posted under the post straight after publishing. Handy for hashtags and extra links."
                          value={optionsFor("FACEBOOK").firstComment}
                          limit={8_000}
                          onChange={(value) => updateOptions("FACEBOOK", { firstComment: value })}
                        />
                      ) : null}

                      {activeTab === "LINKEDIN" ? (
                        <>
                          <div className="field">
                            <label className="field-label" htmlFor="linkedin-visibility">
                              Who can see this
                            </label>
                            <select
                              id="linkedin-visibility"
                              className="input"
                              value={optionsFor("LINKEDIN").visibility}
                              onChange={(event) =>
                                updateOptions("LINKEDIN", {
                                  visibility: event.target.value as PlatformOptionsState["visibility"],
                                })
                              }
                            >
                              <option value="PUBLIC">Anyone on LinkedIn</option>
                              <option value="CONNECTIONS">First-degree connections only</option>
                              <option value="LOGGED_IN">Signed-in members only</option>
                            </select>
                            <span className="field-hint">
                              Company pages always publish publicly; this applies to personal profiles.
                            </span>
                          </div>

                          <FirstCommentField
                            platform="LINKEDIN"
                            label="First comment"
                            hint="Posted by the same author right after publishing."
                            value={optionsFor("LINKEDIN").firstComment}
                            limit={1_250}
                            onChange={(value) => updateOptions("LINKEDIN", { firstComment: value })}
                          />
                        </>
                      ) : null}

                      {activeTab === "X" ? (
                        <>
                          <div className="field">
                            <label className="field-label" htmlFor="x-replies">
                              Who can reply
                            </label>
                            <select
                              id="x-replies"
                              className="input"
                              value={optionsFor("X").replySettings}
                              onChange={(event) =>
                                updateOptions("X", {
                                  replySettings: event.target.value as PlatformOptionsState["replySettings"],
                                })
                              }
                            >
                              <option value="everyone">Everyone</option>
                              <option value="following">Accounts you follow</option>
                              <option value="mentioned">Only accounts you mention</option>
                            </select>
                          </div>

                          <FirstCommentField
                            platform="X"
                            label="Follow-up reply"
                            hint="X has no comments, so this is posted as a reply to your own post, which counts as a second post."
                            value={optionsFor("X").firstComment}
                            limit={280}
                            onChange={(value) => updateOptions("X", { firstComment: value })}
                          />
                        </>
                      ) : null}
                        </>
                      )}

                      {chosen.length > 0 && platformProblems.length > 0 ? (
                        <ul className="platform-problems" role="alert">
                          {platformProblems.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      ) : null}

                      {chosen.length === 0 ? (
                        <p className="small faint">
                          Tick an account above to include {PLATFORM_SHORT[activeTab]} in this post.
                        </p>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            </section>
          </div>

          <aside className="composer-rail">
            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Publishing to</h2>
              </div>
              <div className="panel-body">
                {selectedPlatforms.length === 0 ? (
                  <p className="small muted">
                    No account selected yet. Open a platform tab and tick the account this post
                    should go to.
                  </p>
                ) : (
                  <ul className="target-summary">
                    {selectedPlatforms.map((platform) => (
                      <li key={platform} className="target-summary-row">
                        <button
                          type="button"
                          className="target-summary-button"
                          onClick={() => setActiveTab(platform)}
                        >
                          <span className="target-summary-name">{PLATFORM_SHORT[platform]}</span>
                          <span className="small faint">
                            {(selectedByPlatform.get(platform) ?? [])
                              .map((account) => account.displayName)
                              .join(", ")}
                          </span>
                        </button>
                        <span className="small faint">{captions[platform]?.trim().length ?? 0} chars</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="panel" style={{ marginTop: 16 }}>
              <div className="panel-head">
                <h2 className="panel-title">When</h2>
              </div>
              <div className="panel-body">
                <div className="mode-switch" role="radiogroup" aria-label="Publishing mode">
                  {(["draft", "schedule", "now"] as Mode[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={mode === option}
                      className="mode-option"
                      data-active={mode === option ? "true" : "false"}
                      onClick={() => setMode(option)}
                    >
                      {option === "draft"
                        ? "Save draft"
                        : option === "schedule"
                          ? "Schedule"
                          : "Publish now"}
                    </button>
                  ))}
                </div>

                {mode === "schedule" ? (
                  <div className="field" style={{ marginTop: 14 }}>
                    <label className="field-label" htmlFor="scheduled-at">
                      Date and time
                    </label>
                    <input
                      id="scheduled-at"
                      type="datetime-local"
                      className="input"
                      value={scheduledAt}
                      onChange={(event) => setScheduledAt(event.target.value)}
                      required
                    />
                    <span className="field-hint">Times are in {defaultTimeZone}.</span>
                  </div>
                ) : null}

                {mode === "now" ? (
                  <p className="form-banner composer-note" style={{ marginTop: 14 }}>
                    This publishes immediately to every selected account. It cannot be undone from
                    here.
                  </p>
                ) : null}
              </div>
            </section>
          </aside>
        </div>

        {error ? (
          <div className="form-banner form-banner-error" role="alert" style={{ marginTop: 16 }}>
            {error}
            {fieldErrors.length > 0 ? (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {fieldErrors.map((fieldError, index) => (
                  <li key={index}>
                    <strong>{fieldError.platform}:</strong> {fieldError.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="composer-actions">
          <span className="small faint">
            {selectedAccounts.length === 0
              ? "No accounts selected"
              : `${selectedAccounts.length} account${selectedAccounts.length === 1 ? "" : "s"} across ${selectedPlatforms.length} platform${selectedPlatforms.length === 1 ? "" : "s"}`}
          </span>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || selectedAccounts.length === 0 || submitBlocked}
          >
            {submitting
              ? "Working…"
              : mode === "now"
                ? "Publish now"
                : mode === "schedule"
                  ? "Schedule post"
                  : "Save draft"}
          </button>
        </div>

        {/* No platform lets an API change a published caption, Instagram least of
            all. Saying so next to the button is the last honest moment to check it. */}
        <p className="small faint composer-final-note">
          Captions are final once published — no platform&apos;s API can edit one afterwards, so
          check it with <strong>Preview</strong> first. Deleting and reposting is the only way to
          change the wording.
        </p>
      </form>
    </>
  );
}

/* ---------------------------------------------------------------------------
 * Platform extras
 * ------------------------------------------------------------------------- */

function FirstCommentField({
  platform,
  label,
  hint,
  value,
  limit,
  onChange,
  action,
}: {
  platform: string;
  label: string;
  hint: string;
  value: string;
  limit: number;
  onChange: (value: string) => void;
  action?: React.ReactNode;
}) {
  const over = value.length > limit;

  return (
    <div className="field">
      <div className="caption-head">
        <label className="field-label" htmlFor={`first-comment-${platform}`}>
          {label}
        </label>
        {action}
      </div>
      <textarea
        id={`first-comment-${platform}`}
        className="textarea composer-textarea composer-textarea-sm"
        value={value}
        placeholder="Optional. Posted after the post goes live."
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={over || undefined}
      />
      <span className={over ? "field-error" : "field-hint"}>
        {value.length.toLocaleString()} / {limit.toLocaleString()} · {hint}
      </span>
    </div>
  );
}

/**
 * Instagram-specific controls.
 *
 * Only the options that can be filled in from a browser: a first comment and an
 * image description (alt text). People tags and location ids need Instagram to resolve
 * a handle or a numeric place id first, so they are not offered here — a raw id
 * box invited guesses that publish nothing or fail at the API.
 */
function InstagramExtras({
  options,
  hasImages,
  hashtagCount,
  onChange,
  onMoveHashtags,
}: {
  options: PlatformOptionsState;
  hasImages: boolean;
  hashtagCount: number;
  onChange: (patch: Partial<PlatformOptionsState>) => void;
  onMoveHashtags: () => void;
}) {
  return (
    <div className="extras">
      <div className="extras-head">
        <h3 className="extras-title">Instagram options</h3>
        <span className="small faint">Applied when the post publishes</span>
      </div>

      {hasImages ? (
        <div className="field">
          <label className="field-label" htmlFor="ig-alt-text">
            Image description (alt text)
          </label>
          <textarea
            id="ig-alt-text"
            className="textarea composer-textarea composer-textarea-sm"
            value={options.altText}
            placeholder="Optional. What is in the photo, for people using a screen reader."
            maxLength={1000}
            onChange={(event) => onChange({ altText: event.target.value })}
          />
          <span className="field-hint">
            {options.altText.length.toLocaleString()} / 1,000 · Not shown on the post. Write the
            caption in Instagram content above.
          </span>
        </div>
      ) : null}

      <FirstCommentField
        platform="INSTAGRAM"
        label="First comment"
        hint={`Hashtags belong here. ${hashtagCount} in the caption; Instagram allows ${INSTAGRAM_HASHTAG_LIMIT} in total.`}
        value={options.firstComment}
        limit={2_200}
        onChange={(value) => onChange({ firstComment: value })}
        action={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onMoveHashtags}
            disabled={hashtagCount === 0}
          >
            Move {hashtagCount > 0 ? `${hashtagCount} ` : ""}hashtag
            {hashtagCount === 1 ? "" : "s"} to the comment
          </button>
        }
      />
    </div>
  );
}
