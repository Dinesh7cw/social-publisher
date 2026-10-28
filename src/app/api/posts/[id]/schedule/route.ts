import { z } from "zod";
import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { schedulePost } from "@/server/services/posts";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  // Must carry an offset; a bare local time would be ambiguous.
  scheduledAt: z.string().min(10),
  timeZone: z.string().min(1).max(64),
});

/**
 * Schedule a post.
 *
 * The client sends an offset-bearing ISO timestamp plus the IANA zone. The
 * instant is stored in UTC and the zone alongside it, so the calendar can bucket
 * correctly and a DST boundary has one defined answer.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id } = await params;

  const body = await parseJson(request, schema);

  await schedulePost({
    postId: id,
    scheduledAt: body.scheduledAt,
    timeZone: body.timeZone,
    actorId: session.user.id,
  });

  return NextResponse.json({ id, status: "SCHEDULED" });
});
