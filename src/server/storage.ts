/**
 * Object storage.
 *
 * Two buckets with different jobs:
 *   - private:  originals, never publicly readable
 *   - public:   an immutable projection that Meta and Instagram can fetch
 *
 * The public projection is not a convenience. Instagram and Facebook Pages take
 * a media *URL* and fetch the bytes themselves, so a purely private bucket makes
 * those two platforms impossible. Making the copy explicit, named by content
 * hash, and read-only keeps the exposure bounded and auditable.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";

import { env } from "@/lib/env";

let client: S3Client | null = null;

export function s3(): S3Client {
  if (client) return client;

  client = new S3Client({
    endpoint: env().S3_ENDPOINT,
    region: env().S3_REGION,
    credentials: {
      accessKeyId: env().S3_ACCESS_KEY_ID,
      secretAccessKey: env().S3_SECRET_ACCESS_KEY,
    },
    // Required by MinIO, RustFS and most self-hosted S3 servers.
    forcePathStyle: env().S3_FORCE_PATH_STYLE,
  });

  return client;
}

export const PRIVATE_BUCKET = () => env().S3_BUCKET;
export const PUBLIC_BUCKET = () => `${env().S3_BUCKET}-public`;

/** A presigned PUT so the browser uploads bytes without them passing through us. */
export async function createUploadUrl(params: {
  clientId: string;
  assetId: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<{ url: string; storageKey: string }> {
  // The object key never contains the user's filename: that would leak internal
  // names and make keys enumerable by guessing.
  const storageKey = `clients/${params.clientId}/${params.assetId}/original`;

  const command = new PutObjectCommand({
    Bucket: PRIVATE_BUCKET(),
    Key: storageKey,
    ContentType: params.contentType,
  });

  const url = await getSignedUrl(s3(), command, {
    expiresIn: params.expiresInSeconds ?? 600,
  });

  return { url, storageKey };
}

export async function putObject(params: {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      CacheControl: params.cacheControl,
    }),
  );
}

export async function getObject(params: {
  bucket: string;
  key: string;
}): Promise<Buffer> {
  const response = await s3().send(
    new GetObjectCommand({ Bucket: params.bucket, Key: params.key }),
  );

  if (!response.Body) throw new Error("Object has no body");

  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the public URL for a media asset.
 *
 * The filename is the content hash, so:
 *  - the same image uploaded twice resolves to the same URL (CDN-friendly),
 *  - the path cannot be guessed to enumerate a client's media,
 *  - a replaced image gets a new URL instead of silently changing an old post.
 */
export function publicMediaUrl(contentHash: string, extension: string): string {
  const base = env().MEDIA_PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/${contentHash}.${extension}`;
}

export function publicMediaKey(contentHash: string, extension: string): string {
  return `${contentHash}.${extension}`;
}

export function newAssetId(): string {
  return randomUUID();
}
