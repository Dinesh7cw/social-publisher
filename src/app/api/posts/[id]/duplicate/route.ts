import { NextResponse } from "next/server";

import { route, notFound } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { recordAuditSafe } from "@/server/audit";

type Params = { params: Promise<{ id: string }> };

/**
 * Duplicate a post.
 *
 * The copy is always a fresh DRAFT: it carries no publish state, no platform ids
 * and no attempt history, so it can never be mistaken for the original or
 * accidentally inherit its "published" status.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id } = await params;

  const original = await prisma.post.findUnique({
    where: { id },
    include: {
      targets: { select: { socialAccountId: true, caption: true } },
      media: { orderBy: { position: "asc" }, select: { mediaAssetId: true, position: true } },
    },
  });

  if (!original) throw notFound("Post not found.");

  const copy = await prisma.post.create({
    data: {
      clientId: original.clientId,
      authorId: session.user.id,
      baseCaption: original.baseCaption,
      status: "DRAFT",
      duplicatedFromId: original.id,
      targets: {
        create: original.targets.map((target) => ({
          socialAccountId: target.socialAccountId,
          caption: target.caption,
          status: "PENDING",
        })),
      },
      media: {
        create: original.media.map((row) => ({
          mediaAssetId: row.mediaAssetId,
          position: row.position,
        })),
      },
    },
  });

  await recordAuditSafe({
    actorId: session.user.id,
    action: "POST_DUPLICATED",
    entityType: "Post",
    entityId: copy.id,
    clientId: original.clientId,
    metadata: { duplicatedFromId: original.id },
  });

  return NextResponse.json({ id: copy.id }, { status: 201 });
});
