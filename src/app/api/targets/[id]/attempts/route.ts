import { NextResponse } from "next/server";

import { route, invalid, notFound } from "@/server/http";
import { requireUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";

type Params = { params: Promise<{ id: string }> };

/** The append-only attempt log for one target, used by the "why did this fail" drawer. */
export const GET = route(async (_request: Request, { params }: Params) => {
  await requireUser();
  const { id } = await params;

  const target = await prisma.postTarget.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      platformPostId: true,
      platformPostUrl: true,
      post: { select: { id: true, client: { select: { name: true } } } },
      socialAccount: { select: { platform: true, displayName: true } },
    },
  });

  if (!target) throw notFound("Target not found.");

  const attempts = await prisma.publishingAttempt.findMany({
    where: { postTargetId: id },
    orderBy: { attemptNo: "desc" },
  });

  return NextResponse.json({
    target: {
      id: target.id,
      status: target.status,
      platformPostId: target.platformPostId,
      platformPostUrl: target.platformPostUrl,
      clientName: target.post.client.name,
      platform: target.socialAccount.platform,
      accountName: target.socialAccount.displayName,
    },
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      attemptNo: attempt.attemptNo,
      outcome: attempt.outcome,
      httpStatus: attempt.httpStatus,
      platformErrorCode: attempt.platformErrorCode,
      platformErrorMessage: attempt.platformErrorMessage,
      requestId: attempt.requestId,
      startedAt: attempt.startedAt.toISOString(),
      finishedAt: attempt.finishedAt?.toISOString() ?? null,
      durationMs: attempt.durationMs,
    })),
  });
});

void invalid;
