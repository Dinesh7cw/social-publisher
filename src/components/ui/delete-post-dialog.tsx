"use client";

import { useEffect, useRef, useState } from "react";

export interface RemoteDeleteFailure {
  targetId: string;
  platform: string;
  accountName: string;
  message: string;
}

export interface DeletePostResult {
  deleted: boolean;
  remote: {
    deleted: Array<{ targetId: string; platform: string; accountName: string }>;
    failed: RemoteDeleteFailure[];
  } | null;
  message: string;
}

/**
 * Delete a post, with the two decisions kept separate.
 *
 * "Remove from the app" is always available and always safe. "Delete from the
 * platform" is irreversible and sometimes impossible (a platform may not expose
 * a delete endpoint, or the connected token may lack the permission), so it is a
 * second, explicit choice that names exactly what will be removed.
 *
 * The outcome is shown in place instead of closing immediately: a partial
 * failure means some copies are still live, and that has to be read rather than
 * dismissed by a toast that vanishes.
 */
export function DeletePostDialog({
  postId,
  publishedPlatforms,
  onClose,
  onDeleted,
}: {
  postId: string;
  /** Plain-language names of platforms that currently have a live copy. */
  publishedPlatforms: string[];
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [removeFromPlatforms, setRemoveFromPlatforms] = useState(
    publishedPlatforms.length > 0,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeletePostResult | null>(null);

  // Parents pass inline arrows, so these change on every render. Holding them in
  // a ref keeps the key listener bound once instead of rebinding a document
  // listener on every keystroke.
  const latest = useRef({ onClose, pending });

  useEffect(() => {
    // Written after render, which is where React allows a ref to be updated.
    latest.current = { onClose, pending };
  });

  useEffect(() => {
    cancelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      // Escape must not discard a delete that is already in flight.
      if (event.key === "Escape" && !latest.current.pending) latest.current.onClose();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  async function doDelete() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/posts/${postId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Origin: window.location.origin },
        body: JSON.stringify({ removeFromPlatforms }),
      });

      // 207 is a valid result, not a failure: the post left the app and some
      // platform copies did not. The body has the detail.
      const body = (await response.json().catch(() => null)) as
        | (DeletePostResult & { error?: { message?: string } })
        | null;

      if (!response.ok && response.status !== 207) {
        setError(body?.error?.message ?? "Could not delete this post.");
        setPending(false);
        return;
      }

      setPending(false);
      if (body) setResult(body);
      onDeleted?.();
    } catch {
      setError("Could not reach the server. The post was not deleted.");
      setPending(false);
    }
  }

  // --- Result state -------------------------------------------------------
  if (result) {
    const failed = result.remote?.failed ?? [];

    return (
      <Shell
        title={failed.length > 0 ? "Deleted, with exceptions" : "Post deleted"}
        onClose={onClose}
        foot={
          <button type="button" className="btn btn-secondary" onClick={onClose} ref={cancelRef}>
            Close
          </button>
        }
      >
        <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
          {result.message}
        </p>

        {failed.length > 0 ? (
          <ul className="delete-failures">
            {failed.map((item) => (
              <li key={item.targetId}>
                <strong>
                  {item.platform} · {item.accountName}
                </strong>
                <span className="cell-sub">{item.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Shell>
    );
  }

  // --- Decision state -----------------------------------------------------
  return (
    <Shell
      title="Delete this post?"
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} ref={cancelRef}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void doDelete()}
            disabled={pending}
          >
            {pending ? "Deleting…" : "Delete post"}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
        The post disappears from the app, the calendar and the history. This cannot be undone.
      </p>

      {publishedPlatforms.length > 0 ? (
        <label className="delete-option">
          <input
            type="checkbox"
            checked={removeFromPlatforms}
            onChange={(event) => setRemoveFromPlatforms(event.target.checked)}
            disabled={pending}
          />
          <span className="delete-option-main">
            <span>Also delete the live copy from {publishedPlatforms.join(", ")}</span>
            <span className="cell-sub">
              {removeFromPlatforms
                ? "The audience will no longer see it. A platform can refuse this when the connected account is missing a delete permission."
                : "The post stays live on the platform. Only your record of it is removed."}
            </span>
          </span>
        </label>
      ) : (
        <p className="small faint" style={{ margin: 0 }}>
          Nothing has been published yet, so there is no live copy to take down.
        </p>
      )}

      {error ? (
        <div className="form-banner form-banner-error" role="alert">
          {error}
        </div>
      ) : null}
    </Shell>
  );
}

function Shell({
  title,
  onClose,
  foot,
  children,
}: {
  title: string;
  onClose: () => void;
  foot: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 460 }}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="delete-title">
            {title}
          </h2>
        </div>
        <div className="dialog-body" style={{ display: "grid", gap: 14 }}>
          {children}
        </div>
        <div className="dialog-foot">{foot}</div>
      </div>
    </div>
  );
}
