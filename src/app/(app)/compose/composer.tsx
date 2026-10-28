"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { PLATFORM_SHORT, type PlatformId } from "@/lib/domain";
import "./composer.css";

export interface ComposerClient {
  id: string;
  name: string;
  accounts: Array<{
    id: string;
    platform: PlatformId;
    displayName: string;
    accountType: string;
    status: string;
  }>;
}

interface PlatformLimit {
  captionLimit: number | null;
  requiresMedia: boolean;
  maxImages: number;
  maxCharsLabel: string | null;
  linkAffectsCost: boolean;
}

type Mode = "now" | "schedule" | "draft";

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

export function Composer({
  clients,
  limits,
  platforms,
  defaultTimeZone,
}: {
  clients: ComposerClient[];
  limits: Record<string, PlatformLimit>;
  platforms: Array<{ platform: string; available: boolean; message: string | null }>;
  defaultTimeZone: string;
}) {
  const router = useRouter();

  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [caption, setCaption] = useState("");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Mode>("draft");
  const [scheduledAt, setScheduledAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Array<{ platform: string; message: string }>>([]);

  const client = clients.find((c) => c.id === clientId);

  const accountById = useMemo(() => {
    const map = new Map<string, { account: ComposerClient["accounts"][number]; clientName: string }>();
    for (const c of clients) {
      for (const account of c.accounts) {
        map.set(account.id, { account, clientName: c.name });
      }
    }
    return map;
  }, [clients]);

  const chosenPlatforms = useMemo(() => {
    const set = new Set<PlatformId>();
    for (const id of selectedAccounts) {
      const entry = accountById.get(id);
      if (entry) set.add(entry.account.platform);
    }
    return [...set];
  }, [selectedAccounts, accountById]);

  // Live per-platform limits, so the writer sees the strictest constraint while
  // typing instead of after submitting.
  const constraint = useMemo(() => {
    if (chosenPlatforms.length === 0) return null;

    return chosenPlatforms.map((platform) => {
      const limit = limits[platform];
      if (!limit) return null;

      const text = overrides[platform] ?? caption;
      const used = platform === "X" ? countForX(text) : text.length;
      const cap = limit.captionLimit;

      return {
        platform,
        used,
        cap,
        remaining: cap === null ? null : cap - used,
        over: cap !== null && used > cap,
        requiresMedia: limit.requiresMedia,
      };
    });
  }, [chosenPlatforms, overrides, caption, limits]);

  const hasOverLimit = constraint?.some((c) => c?.over) ?? false;
  const anyRequiresMedia = constraint?.some((c) => c?.requiresMedia) ?? false;

  const xHasLink =
    chosenPlatforms.includes("X") && limits.X?.linkAffectsCost
      ? /https?:\/\/\S+/i.test(overrides.X ?? caption)
      : false;

  function toggleAccount(accountId: string) {
    setSelectedAccounts((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId],
    );
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);

    if (!clientId) {
      setError("Choose a client first.");
      return;
    }
    if (selectedAccounts.length === 0) {
      setError("Choose at least one account to publish to.");
      return;
    }
    if (mode === "schedule" && !scheduledAt) {
      setError("Choose a date and time to schedule this post.");
      return;
    }
    if (hasOverLimit) {
      setError("Some captions are over their platform limit. Shorten them and try again.");
      return;
    }

    setSubmitting(true);

    try {
      // 1. Create the draft with every target.
      const createResponse = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({
          clientId,
          baseCaption: caption,
          mediaAssetIds: [],
          targets: selectedAccounts.map((id) => {
            const platform = accountById.get(id)?.account.platform;
            const override = platform ? overrides[platform] : undefined;
            return {
              socialAccountId: id,
              caption: override?.trim() ? override : null,
            };
          }),
        }),
      });

      if (!createResponse.ok) {
        const body = (await createResponse.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not create the post.");
        setSubmitting(false);
        return;
      }

      const { id } = (await createResponse.json()) as { id: string };

      // 2. Ask the server to validate every target before doing anything real.
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
        const failures = validation.results
          .filter((r) => !r.ok)
          .flatMap((r) =>
            r.issues.map((issue) => ({ platform: `${r.accountName}`, message: issue.message })),
          );

        setFieldErrors(failures);
        setError("This post cannot publish to every selected account yet.");
        setSubmitting(false);

        // The draft still exists, so the work is not lost.
        router.push(`/compose?draft=${id}`);
        return;
      }

      // 3. Schedule or publish.
      if (mode === "schedule") {
        const localDate = new Date(scheduledAt);
        const response = await fetch(`/api/posts/${id}/schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: window.location.origin },
          body: JSON.stringify({
            scheduledAt: localDate.toISOString(),
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

        router.push("/calendar");
        return;
      }

      if (mode === "now") {
        const response = await fetch(`/api/posts/${id}/publish`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: window.location.origin,
            // Deterministic per submit attempt: a double-click reuses the key and
            // the server replays instead of publishing twice.
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

        router.push("/history");
        return;
      }

      router.push("/calendar");
    } catch {
      setError("Could not reach the server. Your draft may not have been saved.");
      setSubmitting(false);
    }
  }

  if (clients.length === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Create post</h1>
          </div>
        </div>
        <div className="empty-state">
          <p className="empty-title">Add a client first</p>
          <p className="small">Posts belong to a client, so there must be at least one to write for.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Create post</h1>
          <p className="page-sub">Write once, then adjust the caption for each platform.</p>
        </div>
      </div>

      <form onSubmit={onSubmit}>
        <div className="composer-grid">
          <div className="composer-main">
            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Caption</h2>
                {constraint ? (
                  <span className="small faint">
                    {constraint
                      .filter((c) => c !== null)
                      .map((c) => `${PLATFORM_SHORT[c!.platform]} ${c!.remaining !== null ? `${c!.remaining} left` : "no limit"}`)
                      .join(" · ")}
                  </span>
                ) : null}
              </div>

              <div className="panel-body">
                <div className="field">
                  <label className="field-label" htmlFor="caption">
                    Post text
                  </label>
                  <textarea
                    id="caption"
                    className="textarea composer-textarea"
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder="What should CW say?"
                    aria-describedby="caption-hint"
                  />
                  <span className="field-hint" id="caption-hint">
                    {caption.length.toLocaleString()} characters. Each platform shows its own count
                    below.
                  </span>
                </div>

                {anyRequiresMedia ? (
                  <p className="form-banner form-banner-error" style={{ marginTop: 12 }}>
                    Instagram needs at least one image or video. Media upload is not wired into this
                    build yet, so Instagram targets will be rejected by validation.
                  </p>
                ) : null}

                {xHasLink ? (
                  <p className="form-banner composer-note" style={{ marginTop: 12 }}>
                    This post contains a link. X charges a higher rate for posts with URLs.
                  </p>
                ) : null}
              </div>
            </section>

            {chosenPlatforms.length > 0 ? (
              <section className="panel" style={{ marginTop: 24 }}>
                <div className="panel-head">
                  <h2 className="panel-title">Per-platform captions</h2>
                  <span className="small faint">Leave blank to use the main caption</span>
                </div>
                <div className="panel-body" style={{ display: "grid", gap: 18 }}>
                  {chosenPlatforms.map((platform) => {
                    const limit = limits[platform];
                    const text = overrides[platform] ?? caption;
                    const used = platform === "X" ? countForX(text) : text.length;
                    const over = limit?.captionLimit !== null && used > (limit?.captionLimit ?? 0);

                    return (
                      <div key={platform} className="field">
                        <label className="field-label" htmlFor={`override-${platform}`}>
                          {PLATFORM_SHORT[platform]}
                        </label>
                        <textarea
                          id={`override-${platform}`}
                          className="textarea"
                          value={overrides[platform] ?? ""}
                          placeholder={caption || "Uses the main caption"}
                          onChange={(e) =>
                            setOverrides((current) => ({ ...current, [platform]: e.target.value }))
                          }
                          aria-invalid={over || undefined}
                          rows={3}
                        />
                        <span className={over ? "field-error" : "field-hint"}>
                          {used.toLocaleString()}
                          {limit?.captionLimit !== null ? ` / ${limit?.captionLimit?.toLocaleString()}` : ""}
                          {over ? " (too long)" : ""}
                          {platform === "X" && limit?.maxCharsLabel
                            ? ` (${limit.maxCharsLabel})`
                            : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </div>

          <aside className="composer-rail">
            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">Client and accounts</h2>
              </div>
              <div className="panel-body">
                <div className="field" style={{ marginBottom: 16 }}>
                  <label className="field-label" htmlFor="client">
                    Client
                  </label>
                  <select
                    id="client"
                    className="select"
                    value={clientId}
                    onChange={(e) => {
                      setClientId(e.target.value);
                      // Accounts belong to a client, so switching resets targets.
                      setSelectedAccounts([]);
                      setOverrides({});
                    }}
                  >
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                {client && client.accounts.length === 0 ? (
                  <p className="small muted">
                    This client has no connected accounts. Connect one on the social accounts page.
                  </p>
                ) : (
                  <fieldset className="account-list">
                    <legend className="field-label" style={{ marginBottom: 8 }}>
                      Publish to
                    </legend>
                    {client?.accounts.map((account) => {
                      const availability = platforms.find((p) => p.platform === account.platform);
                      const disabled = !availability?.available || account.status === "EXPIRED";

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
                              {PLATFORM_SHORT[account.platform]}
                              {account.status === "EXPIRED" ? " · needs reconnecting" : ""}
                              {!availability?.available
                                ? ` · ${availability?.message ?? "unavailable"}`
                                : ""}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
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
                      {option === "draft" ? "Save draft" : option === "schedule" ? "Schedule" : "Publish now"}
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
                      onChange={(e) => setScheduledAt(e.target.value)}
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
              : `${selectedAccounts.length} account${selectedAccounts.length === 1 ? "" : "s"} selected`}
          </span>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || selectedAccounts.length === 0 || caption.trim().length === 0}
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
      </form>
    </>
  );
}
