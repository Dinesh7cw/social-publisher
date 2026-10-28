import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser } from "@/server/auth/guards";
import { validatePost } from "@/server/services/posts";

type Params = { params: Promise<{ id: string }> };

/**
 * Dry-run validation for every target.
 *
 * The composer calls this before submit so the team sees all four platforms'
 * verdicts at once, rather than discovering the fourth platform's objection
 * after two posts have already gone live.
 */
export const POST = route(async (_request: Request, { params }: Params) => {
  await requireUser();
  const { id } = await params;
  return NextResponse.json(await validatePost(id));
});
