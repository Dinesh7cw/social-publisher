import { z } from "zod";
import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson, requireIdempotencyKey } from "@/server/request";
import { publishNow } from "@/server/services/posts";
import { withIdempotency } from "@/server/services/idempotency";
import { prisma } from "@/server/db";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({}).loose();

/**
 * Publish now.
 *
 * An Idempotency-Key header is mandatory: this is the operation where a double
 * submit puts a real post on a client's page. The key is claimed atomically
 * before anything is enqueued, so the second request of a double-click gets the
 * first request's response instead of publishing again.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id } = await params;

  await parseJson(request, schema);
  const idempotencyKey = requireIdempotencyKey(request);

  const outcome = await withIdempotency({
    key: idempotencyKey,
    userId: session.user.id,
    operation: "post.publish",
    entityId: id,
    successStatus: 202,
    action: async () => {
      await publishNow({ postId: id, actorId: session.user.id });

      const post = await prisma.post.findUnique({
        where: { id },
        select: {
          status: true,
          targets: { select: { id: true, status: true } },
        },
      });

      return { id, status: post?.status, targets: post?.targets ?? [] };
    },
  });

  if (outcome.replayed) {
    return NextResponse.json(
      outcome.stored ?? { id, replayed: true },
      { status: 202 },
    );
  }

  return NextResponse.json(outcome.result, { status: 202 });
});
