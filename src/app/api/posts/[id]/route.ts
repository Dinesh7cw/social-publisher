import { z } from "zod";
import { NextResponse } from "next/server";

import { route, notFound } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { prisma } from "@/server/db";
import { deletePost, type RemoteDeleteOutcome } from "@/server/services/deletion";
import { updatePost } from "@/server/services/posts";

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

  if (!post || post.deletedAt) throw notFound("Post not found.");

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
      deletedAt: t.deletedAt?.toISOString() ?? null,
      options: t.platformOptions,
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
        caption: z.string().max(63_206).nullish(),
        options: z
          .object({
            firstComment: z.string().max(2_200).nullish(),
            altText: z.string().max(1_000).nullish(),
            visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).nullish(),
            replySettings: z.enum(["everyone", "following", "mentioned"]).nullish(),
          })
          .nullish(),
      }),
    )
    .max(20)
    .optional(),
  mediaAssetIds: z.array(z.string()).max(20).optional(),
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id } = await params;

  const body = await parseJson(request, updateSchema);

  await updatePost({
    postId: id,
    actorId: session.user.id,
    baseCaption: body.baseCaption,
    mediaAssetIds: body.mediaAssetIds,
    targets: body.targets?.map((target) => ({
      socialAccountId: target.socialAccountId,
      caption: target.caption,
      options: target.options ?? null,
    })),
  });

  return NextResponse.json({ id, updated: true });
});

const deleteSchema = z.object({
  /**
   * Also ask each platform to remove its copy. Off by default: a draft should
   * never trigger network calls, and an accidental delete must not be able to
   * take down a live post in one click.
   */
  removeFromPlatforms: z.boolean().default(false),
});

/**
 * Delete a post.
 *
 * Removing it from the app always succeeds. Platform removal is best-effort and
 * reported per target, because one platform refusing must not leave the team
 * unable to clear the post out of their own workspace.
 */
export const DELETE = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id } = await params;

  // A DELETE may arrive with no body at all, so an unparseable body means
  // "remove from the app only" rather than an error.
  const body = await parseJson(request, deleteSchema).catch(() => ({
    removeFromPlatforms: false,
  }));

  const result = await deletePost({
    postId: id,
    actorId: session.user.id,
    removeFromPlatforms: body.removeFromPlatforms,
  });

  return NextResponse.json(
    {
      deleted: true,
      remote: result.remote,
      message: describeDeleteResult(result.remote),
    },
    // 207 signals "the app delete worked, some platform copies did not".
    { status: result.remote && result.remote.failed.length > 0 ? 207 : 200 },
  );
});

function describeDeleteResult(remote: RemoteDeleteOutcome | null): string {
  if (!remote) {
    return "Removed from the app. The live copy on each platform was left in place.";
  }

  const deleted = remote.deleted.length;
  const failed = remote.failed.length;

  if (deleted === 0 && failed === 0) {
    return "Removed from the app. Nothing had been published, so there was nothing to take down.";
  }
  if (failed === 0) {
    return `Removed from the app and deleted from ${deleted} platform${deleted === 1 ? "" : "s"}.`;
  }
  if (deleted === 0) {
    return `Removed from the app, but ${failed} platform cop${failed === 1 ? "y" : "ies"} could not be deleted.`;
  }
  return `Removed from the app. Deleted from ${deleted}; ${failed} could not be deleted.`;
}
