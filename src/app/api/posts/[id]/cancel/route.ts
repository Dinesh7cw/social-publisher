import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { cancelPost } from "@/server/services/posts";

type Params = { params: Promise<{ id: string }> };

export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id } = await params;

  await cancelPost({ postId: id, actorId: session.user.id });

  return NextResponse.json({ id, status: "CANCELLED" });
});
