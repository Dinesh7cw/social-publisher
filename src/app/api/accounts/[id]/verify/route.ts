import { NextResponse } from "next/server";

import { route, notFound, ApiError } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { getAdapter, isPlatformAvailable } from "@/server/platforms/registry";
import { getAccountCredentials } from "@/server/auth/token-access";
import { recordAuditSafe } from "@/server/audit";

type Params = { params: Promise<{ id: string }> };

/**
 * Verify a connected account against the platform.
 *
 * This is the honest answer to "is this connection still good?", rather than
 * trusting the stored expiry: a token can be revoked at the platform long before
 * it expires.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  assertSameOrigin(request);
  const session = await requireUser();
  const { id } = await params;

  const account = await prisma.socialAccount.findUnique({
    where: { id },
    select: { id: true, platform: true, externalId: true, displayName: true, clientId: true },
  });

  if (!account) throw notFound("Account not found.");

  if (!isPlatformAvailable(account.platform as never)) {
    throw new ApiError(
      "PLATFORM_DISABLED",
      `${account.platform} is not configured on this deployment, so its connection cannot be checked.`,
    );
  }

  const adapter = getAdapter(account.platform as never);
  const credentials = await getAccountCredentials(id);

  if (!adapter.verify) {
    return NextResponse.json({
      status: "CONNECTED",
      verified: false,
      message: "This platform does not offer a connection check.",
    });
  }

  const result = await adapter.verify(credentials.accessToken, account.externalId);

  if (!result.ok) {
    await prisma.socialAccount.update({
      where: { id },
      data: { status: "EXPIRED" },
    });

    return NextResponse.json(
      {
        status: "EXPIRED",
        verified: false,
        message: result.error?.userMessage ?? "This connection is no longer valid.",
      },
      { status: 200 },
    );
  }

  await prisma.socialAccount.update({
    where: { id },
    data: { status: "CONNECTED", lastVerifiedAt: new Date() },
  });

  await recordAuditSafe({
    actorId: session.user.id,
    action: "ACCOUNT_VERIFIED",
    entityType: "SocialAccount",
    entityId: id,
    clientId: account.clientId,
    metadata: { platform: account.platform },
  });

  return NextResponse.json({
    status: "CONNECTED",
    verified: true,
    scopes: result.scopes ?? credentials.scopes,
    expiresAt: result.expiresAt?.toISOString() ?? null,
  });
});
