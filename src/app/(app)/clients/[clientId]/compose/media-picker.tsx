"use client";

import { useRef, useState } from "react";

export interface ComposerMedia {
  id: string;
  kind: "IMAGE" | "VIDEO";
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  publicUrl: string | null;
}

interface UploadError {
  filename: string;
  message: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Media attached to the post, shared by every selected platform.
 *
 * Uploads go through the app rather than straight to object storage: a direct
 * PUT needs bucket CORS configured, and a composer that silently fails on a
 * fresh deployment is worse than one extra hop.
 */
export function MediaPicker({
  clientId,
  clientName,
  assets,
  onChange,
}: {
  clientId: string;
  clientName: string;
  assets: ComposerMedia[];
  onChange: (next: ComposerMedia[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [errors, setErrors] = useState<UploadError[]>([]);
  const [dragging, setDragging] = useState(false);

  const busy = uploading.length > 0;

  async function uploadFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    setErrors([]);

    const accepted: ComposerMedia[] = [];

    for (const file of files) {
      setUploading((current) => [...current, file.name]);

      const form = new FormData();
      form.set("clientId", clientId);
      form.set("file", file);

      try {
        const response = await fetch("/api/media/upload", {
          method: "POST",
          headers: { Origin: window.location.origin },
          body: form,
        });

        const body = (await response.json().catch(() => null)) as
          | (ComposerMedia & { error?: { message?: string } })
          | null;

        if (!response.ok || !body?.id) {
          setErrors((current) => [
            ...current,
            {
              filename: file.name,
              message: body?.error?.message ?? "That file could not be uploaded.",
            },
          ]);
        } else {
          accepted.push({
            id: body.id,
            kind: body.kind,
            mimeType: body.mimeType,
            byteSize: body.byteSize,
            width: body.width,
            height: body.height,
            publicUrl: body.publicUrl,
          });
        }
      } catch {
        setErrors((current) => [
          ...current,
          { filename: file.name, message: "Could not reach the server." },
        ]);
      } finally {
        setUploading((current) => current.filter((name) => name !== file.name));
      }
    }

    if (accepted.length > 0) onChange([...assets, ...accepted]);
  }

  function removeAsset(id: string) {
    onChange(assets.filter((asset) => asset.id !== id));
  }

  return (
    <div className="media-block">
      <div
        className="media-drop"
        data-dragging={dragging ? "true" : "false"}
        data-busy={busy ? "true" : "false"}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void uploadFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div className="media-drop-text">
          <span className="media-drop-title">
            {busy ? `Uploading ${uploading[0]}…` : "Add photos or video"}
          </span>
          <span className="small faint">
            Drag files here or choose them. JPEG, PNG, WebP, GIF, MP4 or MOV, up to 200 MB.
            Files are attached to {clientName} and shared by every platform you select.
          </span>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void uploadFiles(files);
          }}
        />
      </div>

      {busy ? (
        <ul className="media-progress" aria-live="polite">
          {uploading.map((name) => (
            <li key={name} className="small faint">
              Uploading {name}…
            </li>
          ))}
        </ul>
      ) : null}

      {errors.length > 0 ? (
        <ul className="media-errors" role="alert">
          {errors.map((error) => (
            <li key={`${error.filename}-${error.message}`}>
              <strong>{error.filename}</strong> — {error.message}
            </li>
          ))}
        </ul>
      ) : null}

      {assets.length > 0 ? (
        <>
          <ul className="media-grid">
            {assets.map((asset, index) => (
              <li key={asset.id} className="media-tile">
                {asset.kind === "IMAGE" && asset.publicUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={asset.publicUrl} alt="" className="media-thumb" />
                ) : (
                  <span className="media-thumb media-thumb-fallback">
                    {asset.kind === "VIDEO" ? "Video" : "Image"}
                  </span>
                )}
                <span className="media-tile-meta small faint">
                  {index + 1}. {asset.kind === "VIDEO" ? "Video" : "Image"} ·{" "}
                  {formatBytes(asset.byteSize)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm media-remove"
                  onClick={() => removeAsset(asset.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <span className="field-hint">
            {assets.length} file{assets.length === 1 ? "" : "s"} attached. The order here is the
            carousel order on Instagram.
          </span>
        </>
      ) : null}
    </div>
  );
}
