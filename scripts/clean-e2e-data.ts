/**
 * Remove artefacts left by the end-to-end suite.
 *
 * Development only. The e2e tests exercise the real UI, so their only cleanup
 * path is archiving, which leaves rows behind. This removes them so the dev
 * database stays the two clients the brief names.
 *
 * Usage: pnpm tsx scripts/clean-e2e-data.ts
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("This script must never run against production.");
  }

  const database = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  const name = database[0]?.current_database ?? "";

  if (name.endsWith("_test")) {
    console.log(`Skipping: "${name}" is a test database, which is reset by the tests themselves.`);
    return;
  }

  // Clients the suite created. Their posts and targets cascade or are otherwise
  // unreferenced, so deleting the client is enough.
  const deleted = await prisma.client.deleteMany({
    where: { OR: [{ name: { startsWith: "ZZ E2E" } }, { name: { startsWith: "E2E Client" } }] },
  });

  console.log(`✓ Removed ${deleted.count} e2e client(s) from "${name}"`);

  // Sessions created by the test logins.
  const sessions = await prisma.session.deleteMany({});
  console.log(`✓ Cleared ${sessions.count} session(s)`);

  const remaining = await prisma.client.count();
  console.log(`✓ ${remaining} client(s) remain`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
