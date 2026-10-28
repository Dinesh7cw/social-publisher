"use client";

import { useEffect, useRef } from "react";

/**
 * Confirmation for a destructive action.
 *
 * The confirm button names the object rather than saying "OK", and the body
 * states the consequence in words. Escape closes it, and focus moves to the
 * cancel button so a hasty Enter cannot destroy anything.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive = false,
  pending = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 440 }}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="confirm-title">
            {title}
          </h2>
        </div>

        <div className="dialog-body">
          <p className="muted" id="confirm-body" style={{ fontSize: 14, lineHeight: 1.55 }}>
            {body}
          </p>
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel} ref={cancelRef}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? "btn btn-danger" : "btn btn-primary"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
