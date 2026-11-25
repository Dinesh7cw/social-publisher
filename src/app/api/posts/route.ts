import { z } from "zod";
import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson, readPagination } from "@/server/request";
import { prisma } from "@/server/db";
import { createPost } from "@/server/services/posts";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  clientId: z.string().min(1),
  baseCaption: z.string().max(63_206),
  mediaAssetIds: z.array(z.string().min(1)).max(20).default([]),
  targets: z
    .array(
      z.object({
        socialAccountId: z.string().min(1),
        caption: z.string().max(63_206).nullish(),
        options: z
          .object({
            firstComment: z.string().max(2_200).nullish(),
            altText: z.string().max(1_000).nullish(),
            userTags: z.array(z.string().min(1).max(60)).max(20).optional(),
            locationId: z.string().max(64).nullish(),
            visibility: z.enum(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]).nullish(),
            replySettings: z.enum(["everyone", "following", "mentioned"]).nullish(),
          })
          .nullish(),
      }),
    )
    .min(1, "Choose at least one account.")
    .max(20),
});

export const GET = route(async (request: Request) => {
  await requireUser();

  const url = new URL(request.url);
  const { cursor, limit } = readPagination(url);
  const clientId = url.searchParams.get("clientId");
  const status = url.searchParams.get("status");
  const platform = url.searchParams.get("platform");

  const rows = await prisma.post.findMany({
    where: {
      // Soft-deleted posts are gone from every list but stay in the database for
      // the audit trail.
      deletedAt: null,
      ...(clientId ? { clientId } : {}),
      ...(status && status !== "ALL" ? { status: status as never } : {}),
      ...(platform && platform !== "ALL"
        ? { targets: { some: { socialAccount: { platform: platform as never } } } }
        : {}),
    },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: [{ createdAt: "desc" }],
    include: {
      client: { select: { id: true, name: true } },
      targets: {
        select: {
          id: true,
          status: true,
          socialAccount: { select: { platform: true, displayName: true } },
        },
      },
      media: { orderBy: { position: "asc" }, select: { mediaAssetId: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    items: page.map((post) => ({
      id: post.id,
      clientId: post.clientId,
      clientName: post.client.name,
      status: post.status,
      baseCaption: post.baseCaption,
      scheduledAt: post.scheduledAt?.toISOString() ?? null,
      publishedAt: post.publishedAt?.toISOString() ?? null,
      createdAt: post.createdAt.toISOString(),
      mediaCount: post.media.length,
      targets: post.targets.map((t) => ({
        id: t.id,
        status: t.status,
        platform: t.socialAccount.platform,
        accountName: t.socialAccount.displayName,
      })),
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  });
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await requireUser();

  const body = await parseJson(request, createSchema);

  const created = await createPost({
    clientId: body.clientId,
    baseCaption: body.baseCaption,
    mediaAssetIds: body.mediaAssetIds,
    targets: body.targets.map((t) => ({
      socialAccountId: t.socialAccountId,
      caption: t.caption,
      options: t.options ?? null,
    })),
    authorId: session.user.id,
  });

  return NextResponse.json(created, { status: 201 });
});
