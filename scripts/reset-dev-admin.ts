/**
 * Dev maintenance: reset the seeded admin's password and remove E2E leftovers.
 *
 * Development only. This exists because the seed uses `upsert` with an empty
 * `update`, so re-running it does not change an existing password — which is the
 * right behaviour for production but unhelpful when a dev database has drifted.
 *
 * Usage: pnpm tsx scripts/reset-dev-admin.ts
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { hashPassword } from "../src/server/auth/password.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("This script must never run against production.");
  }

  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@colorwhistle.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe!2026";

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: process.env.SEED_ADMIN_NAME ?? "CW Admin",
      passwordHash,
      role: "ADMIN",
      timeZone: "Asia/Kolkata",
    },
    update: { passwordHash, isActive: true, role: "ADMIN" },
  });

  console.log(`✓ Password reset for ${user.email}`);

  // Remove clients the end-to-end suite created. Postgres `startsWith` needs an
  // explicit mode; without one Prisma matches case-sensitively against a pattern
  // that did not behave as written, so the LIKE form is used directly.
  const deleted = await prisma.$executeRawUnsafe(
    `DELETE FROM "Client" WHERE name LIKE 'E2E Client%'`,
  );

  console.log(`✓ Removed ${deleted} end-to-end test client(s)`);

  // Ensure the two clients from the brief exist.
  for (const client of [
    { name: "ColorWhistle", slug: "colorwhistle", notes: "CW's own marketing channels." },
    { name: "Sri Krishna", slug: "sri-krishna", notes: null },
  ]) {
    await prisma.client.upsert({
      where: { slug: client.slug },
      create: { ...client, createdById: user.id },
      update: {},
    });
  }

  console.log("✓ Seed clients present");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
