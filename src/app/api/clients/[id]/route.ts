import { z } from "zod";
import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser, requireAdmin, assertSameOrigin } from "@/server/auth/guards";
import { parseJson, clientIp } from "@/server/request";
import { getClient, updateClient } from "@/server/services/clients";

export const dynamic = "force-dynamic";

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    contactName: z.string().trim().max(120).nullish(),
    contactEmail: z.union([z.email(), z.literal("")]).nullish(),
    notes: z.string().trim().max(4000).nullish(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Nothing to update." });

type Params = { params: Promise<{ id: string }> };

export const GET = route(async (_request: Request, { params }: Params) => {
  await requireUser();
  const { id } = await params;
  return NextResponse.json(await getClient(id));
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireAdmin();
  const { id } = await params;

  const body = await parseJson(request, updateSchema);

  const client = await updateClient({
    id,
    ...body,
    actorId: session.user.id,
    ip: clientIp(request),
  });

  return NextResponse.json(client);
});
