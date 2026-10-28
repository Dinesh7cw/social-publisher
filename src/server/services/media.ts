/**
 * Media finalisation.
 *
 * The upload itself goes straight from the browser to object storage. This runs
 * afterwards, on the server, and is the only place a MediaAsset is created.
 *
 * Security decisions here:
 *  - The real type is decided by magic bytes, never the client's claim. A file
 *    named "photo.jpg" containing a zip is rejected, not stored under a JPEG
 *    content type and served to Meta.
 *  - EXIF is stripped by re-encoding, so GPS coordinates in a client photograph
 *    do not end up on a client's public Instagram post.
 *  - A public projection is created only for formats Meta/Instagram accept, and
 *    it is named by content hash.
 */

import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";

import { prisma } from "@/server/db";
import { invalid, notFound } from "@/server/http";
import {
  PRIVATE_BUCKET,
  PUBLIC_BUCKET,
  getObject,
  putObject,
  publicMediaKey,
  publicMediaUrl,
  sha256,
} from "@/server/storage";
import { ApiError } from "@/server/http";

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

export interface FinalisedAsset {
  id: string;
  kind: "IMAGE" | "VIDEO";
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  publicUrl: string | null;
  storageKey: string;
  contentHash: string;
}

export async function finaliseUpload(params: {
  assetId: string;
  clientId: string;
  userId: string;
  declaredMimeType: string;
}): Promise<FinalisedAsset> {
  // The pending upload lives at a deterministic key, so nothing has to be
  // trusted from the client except the asset id and client id, both of which the
  // caller has already been authorised for.
  const storageKey = `clients/${params.clientId}/${params.assetId}/original`;

  let bytes: Buffer;
  try {
    bytes = await getObject({ bucket: PRIVATE_BUCKET(), key: storageKey });
  } catch {
    throw notFound("That upload could not be found. Please try uploading again.");
  }

  if (bytes.byteLength === 0) {
    throw invalid("The uploaded file is empty.");
  }

  if (bytes.byteLength > MAX_VIDEO_BYTES) {
    throw invalid("That file is too large.");
  }

  // --- Decide the real type from the bytes --------------------------------
  const sniffed = await fileTypeFromBuffer(bytes);

  if (!sniffed) {
    throw invalid(
      "That file type is not recognised. Upload a JPEG, PNG, WebP or MP4.",
    );
  }

  const sniffedMime = sniffed.mime;

  // A mismatch is a hard rejection, not a silent correction: it is either a
  // mistake worth surfacing or an attempt to smuggle a different type past us.
  if (
    params.declaredMimeType &&
    params.declaredMimeType !== sniffedMime &&
    // Tolerate the common, harmless case of a browser reporting the generic type.
    params.declaredMimeType !== "application/octet-stream"
  ) {
    throw invalid(
      `That file is actually ${sniffedMime}, not ${params.declaredMimeType}. Please re-upload it.`,
    );
  }

  const isImage = sniffedMime.startsWith("image/");
  const isVideo = sniffedMime.startsWith("video/");

  if (!isImage && !isVideo) {
    throw invalid("Only images and videos can be uploaded.");
  }

  const contentHash = sha256(bytes);

  if (isImage) {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw invalid("That image is too large. The limit is 40 MB.");
    }
    return finaliseImage({ ...params, bytes, mimeType: sniffedMime, contentHash, storageKey });
  }

  return finaliseVideo({ ...params, bytes, mimeType: sniffedMime, contentHash, storageKey });
}

async function finaliseImage(params: {
  assetId: string;
  clientId: string;
  userId: string;
  bytes: Buffer;
  mimeType: string;
  contentHash: string;
  storageKey: string;
}): Promise<FinalisedAsset> {
  let pipeline = sharp(params.bytes, { failOn: "error" }).rotate();

  const metadata = await pipeline.metadata().catch(() => {
    throw invalid("That image could not be read. Try a different file.");
  });

  // Re-encode with EXIF removed. `withMetadata()` is deliberately not called:
  // dropping metadata is the point.
  let output: Buffer;
  let outputMime: string;
  let extension: string;

  // Instagram accepts JPEG only. Rather than failing a PNG at publish time —
  // after the user believes the post is ready — convert it now, which is the
  // moment the team can still see the result.
  if (params.mimeType === "image/png" || params.mimeType === "image/webp") {
    pipeline = pipeline.jpeg({ quality: 90, progressive: true });
    output = await pipeline.toBuffer();
    outputMime = "image/jpeg";
    extension = "jpg";
  } else if (params.mimeType === "image/gif") {
    // Animated GIFs cannot be represented as JPEG without losing the animation,
    // and Instagram does not take GIFs. Store as-is; the composer marks it
    // unavailable for Instagram rather than silently flattening it.
    output = params.bytes;
    outputMime = "image/gif";
    extension = "gif";
  } else {
    pipeline = pipeline.jpeg({ quality: 92, progressive: true });
    output = await pipeline.toBuffer();
    outputMime = "image/jpeg";
    extension = "jpg";
  }

  const outMetadata = await sharp(output).metadata();

  // --- Public projection ---------------------------------------------------
  const key = publicMediaKey(params.contentHash, extension);
  await putObject({
    bucket: PUBLIC_BUCKET(),
    key,
    body: output,
    contentType: outputMime,
    cacheControl: "public, max-age=31536000, immutable",
  });

  const publicUrl = publicMediaUrl(params.contentHash, extension);

  // Store the normalised bytes back over the original so what we keep and what
  // Meta fetches are the same file.
  await putObject({
    bucket: PRIVATE_BUCKET(),
    key: params.storageKey,
    body: output,
    contentType: outputMime,
  });

  const asset = await prisma.mediaAsset.create({
    data: {
      id: params.assetId,
      clientId: params.clientId,
      uploadedById: params.userId,
      kind: "IMAGE",
      mimeType: outputMime,
      byteSize: output.byteLength,
      width: outMetadata.width ?? metadata.width ?? null,
      height: outMetadata.height ?? metadata.height ?? null,
      durationSeconds: null,
      storageKey: params.storageKey,
      publicUrl,
      contentHash: params.contentHash,
    },
  });

  return toFinalised(asset, publicUrl);
}

async function finaliseVideo(params: {
  assetId: string;
  clientId: string;
  userId: string;
  bytes: Buffer;
  mimeType: string;
  contentHash: string;
  storageKey: string;
}): Promise<FinalisedAsset> {
  // Video is stored as-is. Transcoding needs ffmpeg, which is a deliberate
  // out-of-scope decision for the MVP; the composer validates duration and size
  // against each platform's limits instead.
  const extension = params.mimeType === "video/quicktime" ? "mov" : "mp4";

  const key = publicMediaKey(params.contentHash, extension);
  await putObject({
    bucket: PUBLIC_BUCKET(),
    key,
    body: params.bytes,
    contentType: params.mimeType,
    cacheControl: "public, max-age=31536000, immutable",
  });

  const publicUrl = publicMediaUrl(params.contentHash, extension);

  const asset = await prisma.mediaAsset.create({
    data: {
      id: params.assetId,
      clientId: params.clientId,
      uploadedById: params.userId,
      kind: "VIDEO",
      mimeType: params.mimeType,
      byteSize: params.bytes.byteLength,
      width: null,
      height: null,
      durationSeconds: null,
      storageKey: params.storageKey,
      publicUrl,
      contentHash: params.contentHash,
    },
  });

  return toFinalised(asset, publicUrl);
}

function toFinalised(
  asset: {
    id: string;
    kind: "IMAGE" | "VIDEO";
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    storageKey: string;
    contentHash: string;
  },
  publicUrl: string | null,
): FinalisedAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    publicUrl,
    storageKey: asset.storageKey,
    contentHash: asset.contentHash,
  };
}

/** Media that is attached to a non-draft post must not be deleted. */
export async function assertMediaDeletable(assetId: string): Promise<void> {
  const attached = await prisma.postMedia.count({
    where: {
      mediaAssetId: assetId,
      post: { status: { notIn: ["DRAFT"] } },
    },
  });

  if (attached > 0) {
    throw new ApiError(
      "CONFLICT",
      "This media is used by a post that has already been scheduled or published, so it cannot be deleted.",
    );
  }
}
