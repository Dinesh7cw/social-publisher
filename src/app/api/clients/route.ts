import { z } from "zod";
import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser, requireAdmin, assertSameOrigin } from "@/server/auth/guards";
import { readPagination, parseJson, clientIp } from "@/server/request";
import { listClients, createClient } from "@/server/services/clients";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactName: z.string().trim().max(120).nullish(),
  contactEmail: z.union([z.email(), z.literal("")]).nullish(),
  notes: z.string().trim().max(4000).nullish(),
});

export const GET = route(async (request: Request) => {
  await requireUser();

  const url = new URL(request.url);
  const { cursor, limit } = readPagination(url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === "ALL" || statusParam === "ARCHIVED" ? statusParam : ("ACTIVE" as const);

  const result = await listClients({
    query: url.searchParams.get("q"),
    status,
    cursor,
    limit,
  });

  return NextResponse.json(result);
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await requireAdmin();

  const body = await parseJson(request, createSchema);

  const client = await createClient({
    name: body.name,
    contactName: body.contactName,
    contactEmail: body.contactEmail,
    notes: body.notes,
    actorId: session.user.id,
    ip: clientIp(request),
  });

  return NextResponse.json(client, { status: 201 });
});
