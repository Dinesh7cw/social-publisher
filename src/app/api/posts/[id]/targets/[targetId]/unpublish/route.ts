import { NextResponse } from "next/server";

import { route, notFound } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { deleteTargetFromPlatform } from "@/server/services/deletion";

type Params = { params: Promise<{ id: string; targetId: string }> };

export const dynamic = "force-dynamic";

/**
 * Delete one platform's copy of a post, leaving the post in the app.
 *
 * This is the surgical version of delete: Instagram copy gone, LinkedIn copy
 * left alone. Failures throw, because the caller asked for exactly one thing
 * and needs to know whether it happened.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id, targetId } = await params;

  // Confirm the target belongs to the post in the URL, so a mismatched path
  // cannot touch some other post's target.
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    select: { postId: true },
  });

  if (!target || target.postId !== id) throw notFound("Target not found.");

  await deleteTargetFromPlatform({ postId: id, targetId, actorId: session.user.id });

  return NextResponse.json({ deleted: true });
});
