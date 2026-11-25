import { NextResponse } from "next/server";

import { route, notFound, forbidden } from "@/server/http";
import { requireUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { decryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

interface PendingAccount {
  externalId: string;
  displayName: string;
  accountType: string;
  handle: string | null;
}

/**
 * The accounts discovered by a finished OAuth flow, for the picker to display.
 *
 * Tokens live in the encrypted payload and are never returned here: the browser
 * only needs names to choose from, and the confirm endpoint reads the tokens
 * server-side. Returning them would put a live token in a page response for no
 * reason.
 */
export const GET = route(async (_request: Request, { params }: Params) => {
  const session = await requireUser();
  const { id } = await params;

  const connectSession = await prisma.connectSession.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      platform: true,
      payloadCipher: true,
      expiresAt: true,
      consumedAt: true,
    },
  });

  if (!connectSession) throw notFound("That connection attempt has expired. Start again.");
  if (connectSession.userId !== session.user.id) {
    throw forbidden("That connection belongs to someone else.");
  }
  if (connectSession.consumedAt) throw notFound("That connection was already used. Start again.");
  if (connectSession.expiresAt.getTime() <= Date.now()) {
    throw notFound("That connection attempt expired. Start again.");
  }

  let payload: { accounts?: PendingAccount[] };
  try {
    payload = JSON.parse(decryptSecret(connectSession.payloadCipher)) as {
      accounts?: PendingAccount[];
    };
  } catch {
    throw notFound("That connection could not be read. Start again.");
  }

  return NextResponse.json({
    id: connectSession.id,
    platform: connectSession.platform,
    accounts: (payload.accounts ?? []).map((account) => ({
      externalId: account.externalId,
      displayName: account.displayName,
      accountType: account.accountType,
      handle: account.handle ?? null,
    })),
  });
});
