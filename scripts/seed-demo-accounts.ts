import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client.js";

/**
 * Demo accounts for a UI walkthrough.
 *
 * Publishing is impossible without real platform credentials, so without these
 * rows the composer can only ever show its empty state. They are named
 * "(demo)" on purpose so nobody mistakes them for a real connection, and every
 * platform still reports "needs credentials" — the composer will only let you
 * save drafts against them.
 *
 *   pnpm db:seed:demo          add demo accounts to every active client
 *   pnpm db:seed:demo -- --remove   delete them again
 */
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const DEMO_TYPES = [
  { platform: "FACEBOOK", accountType: "PAGE", suffix: "Page" },
  { platform: "INSTAGRAM", accountType: "IG_PROFESSIONAL", suffix: "Instagram" },
  { platform: "LINKEDIN", accountType: "ORGANIZATION", suffix: "LinkedIn page" },
  { platform: "X", accountType: "X_ACCOUNT", suffix: "X account" },
] as const;

async function main() {
  const remove = process.argv.includes("--remove");

  if (remove) {
    // PostTarget.socialAccount is onDelete: Restrict, so a plain deleteMany
    // fails with a foreign-key error the moment a demo account has ever been
    // used in a draft. Clear the targets first, then any draft left with no
    // targets at all, and only then the accounts.
    const demoAccounts = await prisma.socialAccount.findMany({
      where: { externalId: { startsWith: "demo-" } },
      select: { id: true },
    });

    if (demoAccounts.length === 0) {
      console.log("no demo accounts to remove");
      return;
    }

    const ids = demoAccounts.map((account) => account.id);

    const targets = await prisma.postTarget.findMany({
      where: { socialAccountId: { in: ids } },
      select: { id: true, postId: true },
    });
    const postIds = [...new Set(targets.map((target) => target.postId))];

    await prisma.postTarget.deleteMany({ where: { socialAccountId: { in: ids } } });

    // A draft whose only target was a demo account is now unpublishable and
    // invisible in the UI, so it is cleaned up rather than left orphaned.
    const orphaned = await prisma.post.findMany({
      where: { id: { in: postIds }, targets: { none: {} } },
      select: { id: true },
    });
    if (orphaned.length > 0) {
      await prisma.post.deleteMany({ where: { id: { in: orphaned.map((post) => post.id) } } });
    }

    const result = await prisma.socialAccount.deleteMany({ where: { id: { in: ids } } });

    console.log(
      `removed ${result.count} demo account(s), ${targets.length} target(s), ` +
        `${orphaned.length} empty draft(s)`,
    );
    return;
  }

  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  });
  if (!admin) throw new Error("No active admin user. Run pnpm db:seed first.");

  const clients = await prisma.client.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
  });
  if (clients.length === 0) throw new Error("No active clients. Run pnpm db:seed first.");

  let created = 0;

  for (const client of clients) {
    for (const type of DEMO_TYPES) {
      const externalId = `demo-${client.id}-${type.platform}`;

      const existing = await prisma.socialAccount.findUnique({
        where: { platform_externalId: { platform: type.platform, externalId } },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.socialAccount.create({
        data: {
          clientId: client.id,
          platform: type.platform,
          externalId,
          displayName: `${client.name} (demo ${type.suffix})`,
          accountType: type.accountType,
          status: "CONNECTED",
          scopes: [],
          connectedById: admin.id,
          tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
          lastVerifiedAt: new Date(),
          secret: {
            create: {
              accessTokenCipher: "demo.unusable",
              keyId: "demo",
              tokenType: "Bearer",
            },
          },
        },
      });
      created += 1;
    }
  }

  console.log(
    `added ${created} demo account(s) across ${clients.length} client(s). ` +
      `They can hold drafts but cannot publish. Remove with: pnpm db:seed:demo -- --remove`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
