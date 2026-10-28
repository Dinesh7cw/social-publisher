import { z } from "zod";
import { NextResponse } from "next/server";

import { route, notFound, ApiError } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { prisma } from "@/server/db";
import { isEditablePostStatus } from "@/lib/domain";

type Params = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, { params }: Params) => {
  await requireUser();
  const { id } = await params;

  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true } },
      targets: {
        orderBy: { createdAt: "asc" },
        include: {
          socialAccount: {
            select: { id: true, platform: true, displayName: true, status: true },
          },
        },
      },
      media: {
        orderBy: { position: "asc" },
        include: { media: true },
      },
    },
  });

  if (!post) throw notFound("Post not found.");

  return NextResponse.json({
    id: post.id,
    clientId: post.clientId,
    clientName: post.client.name,
    status: post.status,
    baseCaption: post.baseCaption,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    scheduledTimeZone: post.scheduledTimeZone,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    createdAt: post.createdAt.toISOString(),
    targets: post.targets.map((t) => ({
      id: t.id,
      socialAccountId: t.socialAccountId,
      platform: t.socialAccount.platform,
      accountName: t.socialAccount.displayName,
      accountStatus: t.socialAccount.status,
      caption: t.caption,
      status: t.status,
      attemptCount: t.attemptCount,
      platformPostId: t.platformPostId,
      platformPostUrl: t.platformPostUrl,
      lastErrorCode: t.lastErrorCode,
      lastErrorMessage: t.lastErrorMessage,
      publishedAt: t.publishedAt?.toISOString() ?? null,
    })),
    media: post.media.map((row) => ({
      id: row.media.id,
      kind: row.media.kind,
      mimeType: row.media.mimeType,
      byteSize: row.media.byteSize,
      width: row.media.width,
      height: row.media.height,
      publicUrl: row.media.publicUrl,
      position: row.position,
    })),
  });
});

const updateSchema = z.object({
  baseCaption: z.string().max(63_206).optional(),
  targets: z
    .array(
      z.object({
        socialAccountId: z.string().min(1),
        caption: z.string().max(63_206),
      }),
    )
    .optional(),
  mediaAssetIds: z.array(z.string()).max(20).optional(),
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  await requireUser();
  const { id } = await params;

  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) throw notFound("Post not found.");

  if (!isEditablePostStatus(post.status)) {
    throw new ApiError(
      "TARGET_NOT_PUBLISHABLE",
      "This post has already been published or is publishing, so it cannot be edited.",
    );
  }

  const body = await parseJson(request, updateSchema);

  await prisma.$transaction(async (tx) => {
    if (body.baseCaption !== undefined) {
      await tx.post.update({ where: { id }, data: { baseCaption: body.baseCaption } });
    }

    if (body.targets) {
      for (const target of body.targets) {
        // Only update captions of targets that already exist on this post: a
        // PATCH must not be able to add an account, which goes through POST.
        await tx.postTarget.updateMany({
          where: { postId: id, socialAccountId: target.socialAccountId },
          data: { caption: target.caption },
        });
      }
    }

    if (body.mediaAssetIds) {
      await tx.postMedia.deleteMany({ where: { postId: id } });
      if (body.mediaAssetIds.length > 0) {
        await tx.postMedia.createMany({
          data: body.mediaAssetIds.map((mediaAssetId, index) => ({
            postId: id,
            mediaAssetId,
            position: index,
          })),
        });
      }
    }
  });

  return NextResponse.json({ id, updated: true });
});
