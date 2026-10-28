import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { allPlatformStatuses } from "@/server/platforms/registry";
import type { PlatformId } from "@/lib/domain";

export const dynamic = "force-dynamic";

/**
 * Connected accounts.
 *
 * The response is built by explicit field selection. Tokens are never included,
 * not even the encrypted form: the UI has no use for them and an accidental
 * spread would leak them.
 */
export const GET = route(async (request: Request) => {
  await requireUser();

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const platform = url.searchParams.get("platform");
  const status = url.searchParams.get("status");

  const accounts = await prisma.socialAccount.findMany({
    where: {
      ...(clientId ? { clientId } : {}),
      ...(platform && platform !== "ALL" ? { platform: platform as never } : {}),
      ...(status && status !== "ALL" ? { status: status as never } : {}),
    },
    orderBy: [{ platform: "asc" }, { displayName: "asc" }],
    select: {
      id: true,
      clientId: true,
      platform: true,
      displayName: true,
      accountType: true,
      status: true,
      scopes: true,
      tokenExpiresAt: true,
      lastVerifiedAt: true,
      createdAt: true,
      client: { select: { name: true } },
    },
  });

  return NextResponse.json({
    items: accounts.map((account) => ({
      id: account.id,
      clientId: account.clientId,
      clientName: account.client.name,
      platform: account.platform,
      displayName: account.displayName,
      accountType: account.accountType,
      status: account.status,
      scopes: account.scopes,
      tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
      lastVerifiedAt: account.lastVerifiedAt?.toISOString() ?? null,
      createdAt: account.createdAt.toISOString(),
    })),
    platforms: allPlatformStatuses().map((p) => ({
      platform: p.platform as PlatformId,
      available: p.available,
      message: p.message,
    })),
  });
});
