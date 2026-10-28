import { z } from "zod";
import { NextResponse } from "next/server";

import { route, notFound } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { prisma } from "@/server/db";
import { retryTarget } from "@/server/services/posts";

type Params = { params: Promise<{ id: string; targetId: string }> };

const schema = z.object({
  /**
   * Required to retry a target whose outcome is UNKNOWN. The platform may
   * already have the post, so a human must confirm they checked before we try
   * again and risk duplicating it.
   */
  confirmUnknown: z.boolean().optional(),
});

export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id, targetId } = await params;

  const body = await parseJson(request, schema);

  // Confirm the target belongs to the post in the URL, so a mismatched path
  // cannot retry some other post's target.
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    select: { postId: true },
  });

  if (!target || target.postId !== id) throw notFound("Target not found.");

  const result = await retryTarget({
    targetId,
    actorId: session.user.id,
    confirmUnknown: body.confirmUnknown,
  });

  if (result.requiresConfirmation) {
    return NextResponse.json(
      {
        error: {
          code: "CONFIRMATION_REQUIRED",
          message:
            "We could not confirm whether this post reached the platform. Check the account first, then confirm the retry.",
        },
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ queued: result.queued }, { status: 202 });
});
