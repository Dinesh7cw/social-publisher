import { z } from "zod";
import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { finaliseUpload } from "@/server/services/media";
import { recordAuditSafe } from "@/server/audit";

type Params = { params: Promise<{ assetId: string }> };

const schema = z.object({
  clientId: z.string().min(1),
  declaredMimeType: z.string().min(3).max(120),
});

/**
 * Finalise an upload.
 *
 * The server reads the object back, decides its real type from magic bytes,
 * strips metadata by re-encoding, and creates the public projection that Meta
 * and Instagram require.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { assetId } = await params;

  const body = await parseJson(request, schema);

  const asset = await finaliseUpload({
    assetId,
    clientId: body.clientId,
    userId: session.user.id,
    declaredMimeType: body.declaredMimeType,
  });

  await recordAuditSafe({
    actorId: session.user.id,
    action: "MEDIA_UPLOADED",
    entityType: "MediaAsset",
    entityId: asset.id,
    clientId: body.clientId,
    metadata: { kind: asset.kind, mimeType: asset.mimeType, byteSize: asset.byteSize },
  });

  return NextResponse.json(asset, { status: 201 });
});
