"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { DeletePostDialog } from "./delete-post-dialog";

/**
 * A delete action for posts rendered by a server component.
 *
 * The dialog is the client-side part; the row itself stays server-rendered and
 * is refreshed after a delete rather than being patched locally, so the counts
 * and totals on the page cannot drift out of sync with the list.
 */
export function DeletePostButton({
  postId,
  publishedPlatforms = [],
  label = "Delete",
  className = "btn btn-ghost btn-sm",
}: {
  postId: string;
  publishedPlatforms?: string[];
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <DeletePostDialog
          postId={postId}
          publishedPlatforms={publishedPlatforms}
          onClose={() => setOpen(false)}
          onDeleted={() => router.refresh()}
        />
      ) : null}
    </>
  );
}
