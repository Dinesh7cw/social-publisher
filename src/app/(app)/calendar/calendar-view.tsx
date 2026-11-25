"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { PLATFORM_SHORT, POST_STATUS_LABEL, postStatusTone, type PlatformId, type PostStatusId } from "@/lib/domain";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeletePostDialog } from "@/components/ui/delete-post-dialog";
import "./calendar.css";

interface CalendarPost {
  id: string;
  clientId: string;
  clientName: string;
  status: PostStatusId;
  baseCaption: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  targets: Array<{ status: string; platform: PlatformId; accountName: string }>;
}

type View = "month" | "week";

/** First day of the month grid, including leading days from the previous month. */
function monthGridStart(year: number, month: number): Date {
  const first = new Date(year, month, 1);
  const weekday = first.getDay(); // 0 = Sunday
  const start = new Date(first);
  start.setDate(first.getDate() - weekday);
  start.setHours(0, 0, 0, 0);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function CalendarView({
  timeZone,
  clientId,
  composeHref = "/compose",
  title = "Content calendar",
}: {
  timeZone: string;
  /** When set, the calendar only shows this client's work and hides the client chip. */
  clientId?: string;
  composeHref?: string;
  title?: string;
}) {
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [posts, setPosts] = useState<CalendarPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<CalendarPost | null>(null);
  const [deleting, setDeleting] = useState<CalendarPost | null>(null);
  const [pending, setPending] = useState(false);
  // Bumping this re-runs the fetch effect without changing the visible range.
  const [reloadToken, setReloadToken] = useState(0);

  const range = useMemo(() => {
    if (view === "week") {
      const start = addDays(anchor, -anchor.getDay());
      start.setHours(0, 0, 0, 0);
      return { start, end: addDays(start, 7) };
    }
    const start = monthGridStart(anchor.getFullYear(), anchor.getMonth());
    return { start, end: addDays(start, 42) };
  }, [view, anchor]);

  /**
   * The effect performs the fetch and writes state only from the promise
   * callbacks, which is the pattern React's compiler lint asks for: nothing is
   * set synchronously in the effect body.
   *
   * Cancellation is a plain flag rather than an AbortController. Aborting a
   * fetch rejects with an AbortError, and when that rejection lands after the
   * component has already re-rendered for a new range, the dev overlay reports
   * it as an uncaught runtime error even though the stale result was correctly
   * ignored. A flag produces the same behaviour without ever throwing.
   */
  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams({
      from: range.start.toISOString(),
      to: range.end.toISOString(),
      timeZone,
    });
    if (clientId) params.set("clientId", clientId);

    void (async () => {
      try {
        const response = await fetch(`/api/calendar?${params.toString()}`);
        if (cancelled) return;
        if (!response.ok) {
          setError("Could not load the calendar.");
          setLoading(false);
          return;
        }
        const body = (await response.json()) as {
          days: Array<{ date: string; posts: CalendarPost[] }>;
        };
        if (cancelled) return;
        setPosts(body.days.flatMap((day) => day.posts));
        setError(null);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError("Could not reach the server.");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [range.start, range.end, timeZone, reloadToken, clientId]);

  /**
   * Loading is raised by the interaction that causes a load, not inside the
   * effect, so a filter change shows the skeleton immediately.
   */
  function beginLoad() {
    setLoading(true);
    setError(null);
  }

  function shiftRange(direction: -1 | 1) {
    beginLoad();
    setAnchor(
      view === "month"
        ? new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1)
        : addDays(anchor, 7 * direction),
    );
  }

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarPost[]>();
    for (const post of posts) {
      const instant = post.scheduledAt ?? post.publishedAt;
      if (!instant) continue;
      // Bucket in the viewer's zone so a post lands on the day it publishes for
      // the client, not the day it falls on in UTC.
      const local = new Date(new Date(instant).toLocaleString("en-US", { timeZone }));
      const key = toDateKey(local);
      const list = map.get(key) ?? [];
      list.push(post);
      map.set(key, list);
    }
    return map;
  }, [posts, timeZone]);

  const days = useMemo(() => {
    const out: Date[] = [];
    const count = view === "week" ? 7 : 42;
    for (let i = 0; i < count; i += 1) out.push(addDays(range.start, i));
    return out;
  }, [range.start, view]);

  const todayKey = toDateKey(new Date());

  async function onCancel(post: CalendarPost) {
    setPending(true);
    const response = await fetch(`/api/posts/${post.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({}),
    });
    setPending(false);

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(body?.error?.message ?? "Could not cancel this post.");
      setCancelling(null);
      return;
    }

    setCancelling(null);
    setReloadToken((token) => token + 1);
  }

  const heading =
    view === "month"
      ? anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
      : `${range.start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${addDays(range.start, 6).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">
            {posts.length === 0
              ? "Nothing is scheduled in this period."
              : `${posts.length} post${posts.length === 1 ? "" : "s"} in this period. Times shown in ${timeZone}.`}
          </p>
        </div>
        <div className="page-actions">
          <Link href={composeHref} className="btn btn-primary">
            Create post
          </Link>
        </div>
      </div>

      <div className="toolbar">
        <div className="calendar-nav">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => shiftRange(-1)}
            aria-label={view === "month" ? "Previous month" : "Previous week"}
          >
            Previous
          </button>
          <strong className="calendar-heading">{heading}</strong>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => shiftRange(1)}
            aria-label={view === "month" ? "Next month" : "Next week"}
          >
            Next
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              beginLoad();
              setAnchor(new Date());
            }}
          >
            Today
          </button>
        </div>

        <div className="toolbar-spacer" />

        <div className="mode-switch calendar-modes" role="radiogroup" aria-label="Calendar view">
          {(["month", "week"] as View[]).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={view === option}
              className="mode-option"
              data-active={view === option ? "true" : "false"}
              onClick={() => {
                beginLoad();
                setView(option);
              }}
            >
              {option === "month" ? "Month" : "Week"}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="form-banner form-banner-error" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="calendar-grid calendar-grid-skeleton" aria-busy="true" aria-label="Loading calendar">
          {Array.from({ length: view === "week" ? 7 : 42 }).map((_, index) => (
            <div key={index} className="calendar-cell">
              <span className="skeleton" style={{ width: 18, height: 12 }} />
            </div>
          ))}
        </div>
      ) : (
        <div className={`calendar-grid ${view === "week" ? "calendar-grid-week" : ""}`}>
          {days.map((day) => {
            const key = toDateKey(day);
            const dayPosts = byDate.get(key) ?? [];
            const isToday = key === todayKey;
            const inMonth = day.getMonth() === anchor.getMonth() || view === "week";

            return (
              <div
                key={key}
                className="calendar-cell"
                data-today={isToday ? "true" : "false"}
                data-outside={!inMonth ? "true" : "false"}
              >
                <div className="calendar-date">
                  <span className="calendar-daynum num">{day.getDate()}</span>
                  {isToday ? <span className="calendar-today-label">Today</span> : null}
                </div>

                {dayPosts.map((post) => (
                  <CalendarChip
                    key={post.id}
                    post={post}
                    showClient={!clientId}
                    onCancel={
                      post.status === "SCHEDULED" || post.status === "FAILED"
                        ? () => setCancelling(post)
                        : undefined
                    }
                    onDelete={() => setDeleting(post)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {cancelling ? (
        <ConfirmDialog
          title="Cancel this scheduled post?"
          body={`This removes the post from the queue for ${cancelling.clientName}. Anything already published stays live.`}
          confirmLabel="Cancel the post"
          destructive
          pending={pending}
          onCancel={() => setCancelling(null)}
          onConfirm={() => void onCancel(cancelling)}
        />
      ) : null}

      {/* Delete is available on every chip, in every state — including posts
          that are already live, where it also offers to take the platform copy
          down. */}
      {deleting ? (
        <DeletePostDialog
          postId={deleting.id}
          publishedPlatforms={[...new Set(
            deleting.targets
              .filter((target) => target.status === "PUBLISHED")
              .map((target) => PLATFORM_SHORT[target.platform]),
          )]}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}
    </>
  );
}

function CalendarChip({
  post,
  onCancel,
  onDelete,
  showClient = true,
}: {
  post: CalendarPost;
  onCancel?: () => void;
  onDelete?: () => void;
  showClient?: boolean;
}) {
  const time = post.scheduledAt ?? post.publishedAt;

  return (
    <div className="calendar-chip" data-status={post.status}>
      <div className="calendar-chip-head">
        <span className="calendar-chip-time num">
          {time
            ? new Date(time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : "—"}
        </span>
        <span className={`pill pill-${postStatusTone(post.status)}`}>
          {POST_STATUS_LABEL[post.status]}
        </span>
      </div>
      {showClient ? <span className="calendar-chip-client">{post.clientName}</span> : null}
      <span className="calendar-chip-caption">{post.baseCaption}</span>
      <span className="calendar-chip-platforms">
        {[...new Set(post.targets.map((t) => PLATFORM_SHORT[t.platform]))].join(" · ")}
      </span>
      {onCancel ? (
        <button type="button" className="calendar-chip-cancel" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
      {onDelete ? (
        <button type="button" className="calendar-chip-delete" onClick={onDelete}>
          Delete
        </button>
      ) : null}
    </div>
  );
}
