import { z } from "zod";
import { NextResponse } from "next/server";

import { route, ApiError, notFound, invalid } from "@/server/http";
import { requireUser, assertSameOrigin } from "@/server/auth/guards";
import { parseJson } from "@/server/request";
import { prisma } from "@/server/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { recordAuditSafe } from "@/server/audit";

const confirmSchema = z.object({
  connectSessionId: z.string().min(1),
  clientId: z.string().min(1),
  externalIds: z.array(z.string().min(1)).min(1, "Choose at least one account."),
});

interface PendingAccount {
  externalId: string;
  displayName: string;
  accountType: string;
  accessToken: string;
  tokenExpiresAt: string | null;
  scopes: string[];
  handle: string | null;
}

interface PendingPayload {
  accounts: PendingAccount[];
  refreshToken: string | null;
  defaultScopes: string[];
}

/**
 * Attach chosen accounts from a completed OAuth flow to a client.
 *
 * Tokens are written encrypted in the same transaction as the account row, so
 * there is no window where an account exists without usable credentials.
 */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const session = await requireUser();

  const body = await parseJson(request, confirmSchema);

  const connectSession = await prisma.connectSession.findUnique({
    where: { id: body.connectSessionId },
  });

  if (!connectSession) throw notFound("That connection attempt has expired. Start again.");
  if (connectSession.consumedAt) throw invalid("That connection was already used. Start again.");
  if (connectSession.expiresAt.getTime() <= Date.now()) {
    throw invalid("That connection attempt expired. Start again.");
  }
  if (connectSession.userId !== session.user.id) {
    throw new ApiError("FORBIDDEN", "That connection belongs to someone else.");
  }

  const client = await prisma.client.findUnique({ where: { id: body.clientId } });
  if (!client || client.status === "ARCHIVED") throw notFound("Client not found.");

  let payload: PendingPayload;
  try {
    payload = JSON.parse(decryptSecret(connectSession.payloadCipher)) as PendingPayload;
  } catch {
    throw invalid("That connection could not be read. Start again.");
  }

  const chosen = payload.accounts.filter((account) =>
    body.externalIds.includes(account.externalId),
  );

  if (chosen.length === 0) throw invalid("None of those accounts were available.");

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];

    for (const account of chosen) {
      // The unique (platform, externalId) constraint means the same page cannot
      // be connected twice — the classic cause of duplicate posts.
      const existing = await tx.socialAccount.findUnique({
        where: {
          platform_externalId: {
            platform: connectSession.platform,
            externalId: account.externalId,
          },
        },
        select: { id: true, clientId: true },
      });

      if (existing && existing.clientId !== body.clientId) {
        throw new ApiError(
          "CONFLICT",
          `One of those accounts is already connected to a different client. Disconnect it there first.`,
        );
      }

      const record = await tx.socialAccount.upsert({
        where: {
          platform_externalId: {
            platform: connectSession.platform,
            externalId: account.externalId,
          },
        },
        create: {
          clientId: body.clientId,
          platform: connectSession.platform,
          externalId: account.externalId,
          displayName: account.displayName,
          accountType: account.accountType as never,
          status: "CONNECTED",
          scopes: account.scopes,
          tokenExpiresAt: account.tokenExpiresAt ? new Date(account.tokenExpiresAt) : null,
          connectedById: session.user.id,
          lastVerifiedAt: new Date(),
        },
        update: {
          displayName: account.displayName,
          status: "CONNECTED",
          scopes: account.scopes,
          tokenExpiresAt: account.tokenExpiresAt ? new Date(account.tokenExpiresAt) : null,
          lastVerifiedAt: new Date(),
        },
        select: { id: true, displayName: true, accountType: true, platform: true },
      });

      await tx.socialAccountSecret.upsert({
        where: { socialAccountId: record.id },
        create: {
          socialAccountId: record.id,
          accessTokenCipher: encryptSecret(account.accessToken),
          refreshTokenCipher: payload.refreshToken
            ? encryptSecret(payload.refreshToken)
            : null,
          tokenType: "Bearer",
          keyId: "k1",
        },
        update: {
          accessTokenCipher: encryptSecret(account.accessToken),
          refreshTokenCipher: payload.refreshToken ? encryptSecret(payload.refreshToken) : null,
          rotatedAt: new Date(),
        },
      });

      rows.push(record);
    }

    await tx.connectSession.update({
      where: { id: connectSession.id },
      data: { consumedAt: new Date() },
    });

    return rows;
  });

  for (const row of created) {
    await recordAuditSafe({
      actorId: session.user.id,
      action: "ACCOUNT_CONNECTED",
      entityType: "SocialAccount",
      entityId: row.id,
      clientId: body.clientId,
      metadata: { platform: row.platform, displayName: row.displayName },
    });
  }

  return NextResponse.json(
    {
      items: created.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        platform: row.platform,
        accountType: row.accountType,
      })),
    },
    { status: 201 },
  );
});
