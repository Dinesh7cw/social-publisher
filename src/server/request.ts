/**
 * Request helpers shared by the API routes: client IP extraction, body parsing
 * with a schema, and idempotency-key handling.
 */

import { z } from "zod";

import { ApiError } from "@/server/http";
import { hashIdentifier } from "@/lib/crypto";

/**
 * Best-effort client IP.
 *
 * Behind the nginx reverse proxy this is the last hop's address. We hash it
 * before storing, so raw addresses never reach the database or the logs.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function clientIpHash(request: Request): string {
  return hashIdentifier(clientIp(request));
}

/**
 * Parse and validate a JSON body.
 *
 * A body larger than 1 MiB is rejected before parsing, so a hostile or buggy
 * client cannot make the server allocate arbitrarily. Media never travels
 * through this path — it is uploaded directly to object storage.
 */
export async function parseJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError("VALIDATION_FAILED", "Expected a JSON request body.");
  }

  const raw = await request.text();
  if (raw.length > 1_048_576) {
    throw new ApiError("VALIDATION_FAILED", "Request body is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("VALIDATION_FAILED", "Request body is not valid JSON.");
  }

  return schema.parse(parsed);
}

const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "Idempotency-Key must be a URL-safe string");

/**
 * Read the Idempotency-Key header.
 *
 * Publishing is the one operation where a duplicate submission puts a real post
 * on a client's page, so the key is mandatory rather than optional.
 */
export function requireIdempotencyKey(request: Request): string {
  const raw = request.headers.get("idempotency-key");
  if (!raw) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "An Idempotency-Key header is required to publish. Refresh the page and try again.",
    );
  }
  return idempotencyKeySchema.parse(raw);
}

/** Read `?cursor=&limit=`. */
export function readPagination(url: URL): { cursor: string | null; limit: number } {
  const cursor = url.searchParams.get("cursor");
  const rawLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
  return { cursor: cursor && cursor.length > 0 ? cursor : null, limit };
}
