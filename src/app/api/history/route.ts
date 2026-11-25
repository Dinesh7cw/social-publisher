import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser } from "@/server/auth/guards";
import { readPagination } from "@/server/request";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * Publishing history: one row per target, which is what the team actually needs
 * to read. A row per post would hide the partial-success case that this system
 * exists to make visible.
 */
export const GET = route(async (request: Request) => {
  await requireUser();

  const url = new URL(request.url);
  const { cursor, limit } = readPagination(url);

  const clientId = url.searchParams.get("clientId");
  const platform = url.searchParams.get("platform");
  const status = url.searchParams.get("status");

  const rows = await prisma.postTarget.findMany({
    where: {
      // Soft-deleted posts are hidden from history too: the row still exists for
      // audit, but it is not part of the team's working view.
      post: { deletedAt: null, ...(clientId ? { clientId } : {}) },
      ...(platform && platform !== "ALL" ? { socialAccount: { platform: platform as never } } : {}),
      ...(status && status !== "ALL" ? { status: status as never } : {}),
    },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: [{ updatedAt: "desc" }],
    include: {
      post: { select: { id: true, baseCaption: true, client: { select: { name: true } } } },
      socialAccount: { select: { platform: true, displayName: true } },
      attempts: { orderBy: { attemptNo: "desc" }, take: 1 },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    items: page.map((row) => {
      const latest = row.attempts[0];
      return {
        id: row.id,
        postId: row.postId,
        clientName: row.post.client.name,
        platform: row.socialAccount.platform,
        accountName: row.socialAccount.displayName,
        caption: row.post.baseCaption,
        status: row.status,
        attemptCount: row.attemptCount,
        platformPostId: row.platformPostId,
        platformPostUrl: row.platformPostUrl,
        lastErrorCode: row.lastErrorCode,
        lastErrorMessage: row.lastErrorMessage,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
        latestAttempt: latest
          ? {
              attemptNo: latest.attemptNo,
              outcome: latest.outcome,
              httpStatus: latest.httpStatus,
              startedAt: latest.startedAt.toISOString(),
              durationMs: latest.durationMs,
            }
          : null,
      };
    }),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  });
});
