import { NextResponse } from "next/server";

import { route, ApiError, notFound } from "@/server/http";
import { requireAdmin, assertSameOrigin } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { recordAuditSafe } from "@/server/audit";
import { clientIp } from "@/server/request";

type Params = { params: Promise<{ id: string }> };

/**
 * Disconnect a social account.
 *
 * The secret is deleted and the row is marked REVOKED rather than removed, so
 * publishing history keeps pointing at a real account name. Refused while work is
 * in flight: disconnecting mid-publish would leave a target the team can neither
 * see through nor complete.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireAdmin();
  const { id } = await params;

  const account = await prisma.socialAccount.findUnique({
    where: { id },
    include: { _count: { select: { targets: true } } },
  });

  if (!account) throw notFound("Account not found.");

  const inFlight = await prisma.postTarget.count({
    where: {
      socialAccountId: id,
      status: { in: ["QUEUED", "PUBLISHING"] },
    },
  });

  if (inFlight > 0) {
    throw new ApiError(
      "CONFLICT",
      `This account has ${inFlight} post${inFlight === 1 ? "" : "s"} queued or publishing. Wait for ${inFlight === 1 ? "it" : "them"} to finish before disconnecting.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.socialAccountSecret.deleteMany({ where: { socialAccountId: id } });
    await tx.socialAccount.update({
      where: { id },
      data: { status: "REVOKED", tokenExpiresAt: null },
    });
  });

  await recordAuditSafe({
    actorId: session.user.id,
    action: "ACCOUNT_DISCONNECTED",
    entityType: "SocialAccount",
    entityId: id,
    clientId: account.clientId,
    metadata: { platform: account.platform, displayName: account.displayName },
    ip: clientIp(request),
  });

  return new NextResponse(null, { status: 204 });
});
