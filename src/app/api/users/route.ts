import { z } from "zod";
import { NextResponse } from "next/server";

import { route, ApiError, invalid } from "@/server/http";
import { requireAdmin, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { prisma } from "@/server/db";
import { hashPassword, validatePasswordStrength } from "@/server/auth/password";
import { recordAuditSafe } from "@/server/audit";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((v) => v.toLowerCase()),
  password: z.string().min(12).max(200),
  role: z.enum(["ADMIN", "MEMBER"]),
});

export const GET = route(async () => {
  await requireAdmin();

  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      timeZone: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ items: users });
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await requireAdmin();

  const body = await parseJson(request, createSchema);

  const strengthError = validatePasswordStrength(body.password);
  if (strengthError) throw invalid(strengthError);

  const existing = await prisma.user.findUnique({
    where: { email: body.email },
    select: { id: true },
  });

  if (existing) {
    // Deliberately specific here: an admin adding a colleague needs to know the
    // email is taken, and this endpoint is admin-only so it is not an
    // enumeration surface for outsiders.
    throw new ApiError("CONFLICT", "Someone already uses that email address.");
  }

  const passwordHash = await hashPassword(body.password);

  const created = await prisma.user.create({
    data: {
      name: body.name,
      email: body.email,
      passwordHash,
      role: body.role,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      timeZone: true,
      createdAt: true,
    },
  });

  await recordAuditSafe({
    actorId: session.user.id,
    action: "USER_CREATED",
    entityType: "User",
    entityId: created.id,
    metadata: { email: created.email, role: created.role },
  });

  return NextResponse.json(
    {
      ...created,
      createdAt: created.createdAt.toISOString(),
      postCount: 0,
      isSelf: false,
    },
    { status: 201 },
  );
});
