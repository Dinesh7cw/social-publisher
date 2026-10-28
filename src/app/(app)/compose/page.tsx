import type { Metadata } from "next";

import { requirePageUser } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { allPlatformStatuses } from "@/server/platforms/registry";
import { CAPABILITIES } from "@/server/platforms/capabilities";
import { Composer, type ComposerClient } from "./composer";

export const metadata: Metadata = { title: "Create post" };
export const dynamic = "force-dynamic";

export default async function ComposePage() {
  const session = await requirePageUser();

  const clients = await prisma.client.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      accounts: {
        where: { status: { in: ["CONNECTED", "EXPIRED", "ERROR"] } },
        orderBy: { displayName: "asc" },
        select: {
          id: true,
          platform: true,
          displayName: true,
          accountType: true,
          status: true,
        },
      },
    },
  });

  const composerClients: ComposerClient[] = clients.map((client) => ({
    id: client.id,
    name: client.name,
    accounts: client.accounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      displayName: account.displayName,
      accountType: account.accountType,
      status: account.status,
    })),
  }));

  const limits = Object.fromEntries(
    Object.entries(CAPABILITIES).map(([platform, caps]) => [
      platform,
      {
        captionLimit: caps.captionLimit,
        requiresMedia: caps.requiresMedia,
        maxImages: caps.maxImages,
        maxCharsLabel:
          platform === "X" ? "links count as 23 characters" : null,
        linkAffectsCost: caps.linkAffectsCost,
      },
    ]),
  );

  return (
    <Composer
      clients={composerClients}
      limits={limits}
      platforms={allPlatformStatuses().map((p) => ({
        platform: p.platform,
        available: p.available,
        message: p.message,
      }))}
      defaultTimeZone={session.user.timeZone}
    />
  );
}
