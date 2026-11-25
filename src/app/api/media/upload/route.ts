import { NextResponse } from "next/server";

import { route, invalid, notFound } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { PRIVATE_BUCKET, newAssetId, putObject } from "@/server/storage";
import { finaliseUpload } from "@/server/services/media";
import { recordAuditSafe } from "@/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload a media file through the app.
 *
 * The presign route exists for a direct-to-storage path, but it needs CORS on
 * the object store for the browser to PUT a file to a different origin. Rather
 * than make every deployment configure bucket CORS before an upload works, this
 * endpoint takes the bytes and writes them server-side. The expensive part —
 * sniffing the real type, stripping EXIF, building the public projection — is
 * the same `finaliseUpload` path either way, so neither route is a shortcut
 * around validation.
 */
const MAX_BYTES = 200 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await requireUser();

  const form = await request.formData().catch(() => null);
  if (!form) throw invalid("The upload could not be read. Please try again.");

  const clientId = String(form.get("clientId") ?? "");
  const file = form.get("file");

  if (!clientId) throw invalid("Choose a client before uploading media.");
  if (!(file instanceof File)) throw invalid("No file was included in the upload.");

  if (file.size === 0) throw invalid("That file is empty.");
  if (file.size > MAX_BYTES) throw invalid("That file is larger than 200 MB.");

  const declaredMimeType = file.type;
  if (declaredMimeType && !ALLOWED_TYPES.has(declaredMimeType)) {
    throw invalid("Only JPEG, PNG, WebP, GIF, MP4 or MOV files can be uploaded.");
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, status: true },
  });
  if (!client) throw notFound("Client not found.");
  if (client.status === "ARCHIVED") {
    throw invalid("This client is archived. Restore it before uploading media.");
  }

  const assetId = newAssetId();
  const storageKey = `clients/${clientId}/${assetId}/original`;
  const bytes = Buffer.from(await file.arrayBuffer());

  await putObject({
    bucket: PRIVATE_BUCKET(),
    key: storageKey,
    body: bytes,
    contentType: declaredMimeType || "application/octet-stream",
  });

  // finalise re-reads the object, sniffs its real type, strips metadata and
  // writes the public projection. Trusting `declaredMimeType` here would let a
  // renamed file through.
  const asset = await finaliseUpload({
    assetId,
    clientId,
    userId: session.user.id,
    declaredMimeType,
  });

  await recordAuditSafe({
    actorId: session.user.id,
    action: "MEDIA_UPLOADED",
    entityType: "MediaAsset",
    entityId: asset.id,
    clientId,
    metadata: { kind: asset.kind, mimeType: asset.mimeType, byteSize: asset.byteSize },
  });

  return NextResponse.json(asset, { status: 201 });
});
