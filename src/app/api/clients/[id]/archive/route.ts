import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireAdmin, assertSameOrigin } from "@/server/auth/guards";
import { clientIp } from "@/server/request";
import { archiveClient, unarchiveClient } from "@/server/services/clients";

type Params = { params: Promise<{ id: string }> };

/** POST /api/clients/:id/archive — archive, or restore with {"restore":true}. */
export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireAdmin();
  const { id } = await params;

  const body = await request
    .clone()
    .json()
    .catch(() => ({}));

  const restore = typeof body === "object" && body !== null && (body as { restore?: unknown }).restore === true;

  const client = restore
    ? await unarchiveClient({ id, actorId: session.user.id, ip: clientIp(request) })
    : await archiveClient({ id, actorId: session.user.id, ip: clientIp(request) });

  return NextResponse.json(client);
});
