import { z } from "zod";
import { NextResponse } from "next/server";

import { route, ApiError, notFound } from "@/server/http";
import { requireAdmin, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { prisma } from "@/server/db";
import { destroyAllSessionsForUser } from "@/server/auth/session";
import { recordAuditSafe } from "@/server/audit";

type Params = { params: Promise<{ id: string }> };

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    role: z.enum(["ADMIN", "MEMBER"]).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Nothing to update." });

export const PATCH = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireAdmin();
  const { id } = await params;

  const body = await parseJson(request, updateSchema);

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw notFound("Team member not found.");

  // An admin must not be able to lock themselves out of the only admin account.
  if (id === session.user.id && (body.role === "MEMBER" || body.isActive === false)) {
    throw new ApiError(
      "CONFLICT",
      "You cannot remove your own admin access or deactivate yourself. Ask another admin.",
    );
  }

  // Never leave the team with zero admins.
  if ((body.role === "MEMBER" || body.isActive === false) && target.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN", isActive: true } });
    if (adminCount <= 1) {
      throw new ApiError("CONFLICT", "There must always be at least one active admin.");
    }
  }

  const updated = await prisma.user.update({
    where: { id },
    data: body,
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });

  // A role change or deactivation must apply immediately, not at next login.
  if (body.role !== undefined || body.isActive === false) {
    await destroyAllSessionsForUser(id);
  }

  await recordAuditSafe({
    actorId: session.user.id,
    action:
      body.isActive === false
        ? "USER_DEACTIVATED"
        : body.role !== undefined
          ? "ROLE_CHANGED"
          : "USER_UPDATED",
    entityType: "User",
    entityId: id,
    metadata: {
      before: { role: target.role, isActive: target.isActive },
      after: body,
    },
  });

  return NextResponse.json(updated);
});
