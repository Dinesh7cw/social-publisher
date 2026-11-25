"use client";

import { useCallback, useEffect, useState } from "react";

import {
  PLATFORM_SHORT,
  TARGET_STATUS_LABEL,
  isRetryable,
  targetStatusTone,
  type PlatformId,
  type TargetStatusId,
} from "@/lib/domain";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeletePostDialog } from "@/components/ui/delete-post-dialog";

interface HistoryRow {
  id: string;
  postId: string;
  clientName: string;
  platform: PlatformId;
  accountName: string;
  caption: string;
  status: TargetStatusId;
  attemptCount: number;
  platformPostId: string | null;
  platformPostUrl: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  publishedAt: string | null;
  updatedAt: string;
  latestAttempt: {
    attemptNo: number;
    outcome: string;
    httpStatus: number | null;
    startedAt: string;
    durationMs: number | null;
  } | null;
}

type StatusFilter = "ALL" | "PUBLISHED" | "FAILED" | "QUEUED";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HistoryTable({ clientId }: { clientId?: string } = {}) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<HistoryRow | null>(null);
  const [confirmUnknown, setConfirmUnknown] = useState<HistoryRow | null>(null);
  const [deleting, setDeleting] = useState<HistoryRow | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async (nextStatus: StatusFilter) => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ limit: "50" });
    if (clientId) params.set("clientId", clientId);
    if (nextStatus === "FAILED") {
      // The two failure states read as one idea to the team.
      params.set("status", "FAILED_PERMANENT");
    } else if (nextStatus !== "ALL") {
      params.set("status", nextStatus);
    }

    try {
      const response = await fetch(`/api/history?${params.toString()}`);
      if (!response.ok) {
        setError("Could not load publishing history.");
        return;
      }
      const body = (await response.json()) as { items: HistoryRow[] };

      // A "failed" filter should include every failure flavour.
      const items =
        nextStatus === "FAILED"
          ? body.items.filter((row) =>
              ["FAILED_PERMANENT", "FAILED_RETRYABLE", "UNKNOWN"].includes(row.status),
            )
          : body.items;

      setRows(items);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    // Fetching is exactly what an effect is for: synchronising with an external
    // system. The setState calls happen inside the async callback, after the
    // await, so they do not cascade within the effect body.
    let cancelled = false;

    void (async () => {
      await load(status);
      if (cancelled) return;
    })();

    return () => {
      cancelled = true;
    };
  }, [status, load]);

  async function doRetry(row: HistoryRow, confirmUnknownFailure: boolean) {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/posts/${row.postId}/targets/${row.id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({ confirmUnknown: confirmUnknownFailure }),
    });

    setPending(false);

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(body?.error?.message ?? "Could not retry this post.");
      setRetrying(null);
      setConfirmUnknown(null);
      return;
    }

    setRetrying(null);
    setConfirmUnknown(null);
    await load(status);
  }

  function onRetryClick(row: HistoryRow) {
    if (row.status === "UNKNOWN") {
      // Ambiguous outcome: a human must confirm they checked the platform.
      setConfirmUnknown(row);
      return;
    }
    setRetrying(row);
  }

  const failedCount = rows.filter((row) =>
    ["FAILED_PERMANENT", "FAILED_RETRYABLE", "UNKNOWN"].includes(row.status),
  ).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Publishing history</h1>
          <p className="page-sub">
            {loading
              ? "Loading…"
              : rows.length === 0
                ? "No publishing activity in this view."
                : `${rows.length} result${rows.length === 1 ? "" : "s"}${failedCount > 0 ? `, ${failedCount} needing attention` : ""}. Each account has its own outcome.`}
          </p>
        </div>
      </div>

      <div className="toolbar">
        <select
          className="select select-sm"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          <option value="ALL">All statuses</option>
          <option value="PUBLISHED">Published</option>
          <option value="FAILED">Failed</option>
          <option value="QUEUED">Queued</option>
        </select>

        <div className="toolbar-spacer" />

        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(status)}>
          Refresh
        </button>
      </div>

      {error ? (
        <div className="form-banner form-banner-error" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="table-card" aria-busy="true">
          <div className="panel-body">
            <div className="skeleton" style={{ height: 18, width: "40%", marginBottom: 14 }} />
            <div className="skeleton" style={{ height: 14, width: "70%", marginBottom: 10 }} />
            <div className="skeleton" style={{ height: 14, width: "60%" }} />
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">Nothing has been published yet</p>
          <p className="small">
            Results appear here for every account a post was sent to, including failures.
          </p>
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Post</th>
                  <th scope="col">Account</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Attempts
                  </th>
                  <th scope="col">When</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ maxWidth: 320 }}>
                      <div className="cell-stack">
                        <span className="cell-primary">{row.clientName}</span>
                        <span className="cell-sub" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                          {row.caption || "No caption"}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack">
                        <span>{row.accountName}</span>
                        <span className="cell-sub">{PLATFORM_SHORT[row.platform]}</span>
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack" style={{ gap: 4 }}>
                        <span className={`pill pill-${targetStatusTone(row.status)}`}>
                          {TARGET_STATUS_LABEL[row.status]}
                        </span>
                        {row.lastErrorMessage ? (
                          <span className="cell-sub" style={{ maxWidth: 320 }}>
                            {row.lastErrorMessage}
                          </span>
                        ) : null}
                        {row.platformPostUrl ? (
                          <a
                            href={row.platformPostUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="cell-sub"
                            style={{ color: "var(--secondary-dark-color)" }}
                          >
                            View post
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td className="num">{row.attemptCount}</td>
                    <td>
                      <span className="small muted">
                        {formatTime(row.publishedAt ?? row.updatedAt)}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        {isRetryable(row.status) ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => onRetryClick(row)}
                          >
                            Retry
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setDeleting(row)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {retrying ? (
        <ConfirmDialog
          title="Retry this post?"
          body={`CW will try to publish to ${retrying.accountName} on ${PLATFORM_SHORT[retrying.platform]} again. This creates a new attempt; earlier attempts stay in the history.`}
          confirmLabel="Retry publishing"
          pending={pending}
          onCancel={() => setRetrying(null)}
          onConfirm={() => void doRetry(retrying, false)}
        />
      ) : null}

      {/* The UNKNOWN case deserves its own words: the post may already exist. */}
      {confirmUnknown ? (
        <ConfirmDialog
          title="Check the account before retrying"
          body={`We could not confirm whether this post reached ${confirmUnknown.accountName}. Open the account and look. If the post is already there, do not retry, or the audience will see it twice.`}
          confirmLabel="Confirmed missing, retry"
          destructive
          pending={pending}
          onCancel={() => setConfirmUnknown(null)}
          onConfirm={() => void doRetry(confirmUnknown, true)}
        />
      ) : null}

      {/*
        Deleting from a history row deletes the whole post, not just this account,
        because that is what the team means by "delete the post". The dialog says
        so, and reports each platform's outcome separately.
      */}
      {deleting ? (
        <DeletePostDialog
          postId={deleting.postId}
          publishedPlatforms={
            deleting.platformPostId && deleting.status === "PUBLISHED"
              ? [PLATFORM_SHORT[deleting.platform]]
              : []
          }
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void load(status);
          }}
        />
      ) : null}
    </>
  );
}
