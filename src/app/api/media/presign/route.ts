import { z } from "zod";
import { NextResponse } from "next/server";

import { route, invalid, notFound } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { prisma } from "@/server/db";
import { createUploadUrl, newAssetId } from "@/server/storage";

const presignSchema = z.object({
  clientId: z.string().min(1),
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(3).max(120),
  byteSize: z.number().int().positive(),
});

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);

const MAX_BYTES = 200 * 1024 * 1024;

/**
 * Presign a direct upload.
 *
 * Type and size are checked here as well as after upload. This check saves the
 * user a wasted upload; the check on finalise is the one that actually protects
 * the system, because a client can lie about Content-Type.
 */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await requireUser();

  const body = await parseJson(request, presignSchema);

  if (!ALLOWED_TYPES.has(body.mimeType)) {
    throw invalid("Only JPEG, PNG, WebP, GIF, MP4 or MOV files can be uploaded.");
  }

  if (body.byteSize > MAX_BYTES) {
    throw invalid("That file is larger than 200 MB.");
  }

  const client = await prisma.client.findUnique({
    where: { id: body.clientId },
    select: { id: true, status: true },
  });

  if (!client || client.status === "ARCHIVED") throw notFound("Client not found.");

  const assetId = newAssetId();
  const { url, storageKey } = await createUploadUrl({
    clientId: body.clientId,
    assetId,
    contentType: body.mimeType,
  });

  return NextResponse.json({
    uploadUrl: url,
    method: "PUT",
    headers: { "Content-Type": body.mimeType },
    assetId,
    storageKey,
    expiresIn: 600,
    // Recorded so finalise can verify it is this user's upload for this client.
    uploadedBy: session.user.id,
  });
});
