/**
 * Seed: the two clients named in the brief, and one admin account.
 *
 * Deliberately does NOT invent social accounts, posts or publishing history.
 * Faking connected accounts or "published" posts would misrepresent the system's
 * state, and the brief is explicit that publication must never be faked. The
 * dashboard therefore shows honest zeros until real accounts are connected.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { hashPassword } from "../src/server/auth/password.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@colorwhistle.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe!2026";
  const name = process.env.SEED_ADMIN_NAME ?? "CW Admin";

  if (process.env.NODE_ENV === "production" && !process.env.SEED_ADMIN_PASSWORD) {
    throw new Error(
      "Refusing to seed a production database with the default password. Set SEED_ADMIN_PASSWORD.",
    );
  }

  const passwordHash = await hashPassword(password);

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name,
      passwordHash,
      role: "ADMIN",
      timeZone: "Asia/Kolkata",
    },
  });

  console.log(`✓ Admin ready: ${admin.email} (${admin.role})`);

  // The two clients named in the brief.
  const clients = [
    {
      name: "ColorWhistle",
      slug: "colorwhistle",
      notes: "CW's own marketing channels.",
    },
    {
      name: "Sri Krishna",
      slug: "sri-krishna",
      notes: null,
    },
  ];

  for (const client of clients) {
    const existing = await prisma.client.findUnique({ where: { slug: client.slug } });
    if (existing) {
      console.log(`· Client already present: ${existing.name}`);
      continue;
    }
    const created = await prisma.client.create({
      data: {
        name: client.name,
        slug: client.slug,
        notes: client.notes,
        createdById: admin.id,
      },
    });
    console.log(`✓ Client created: ${created.name}`);
  }

  console.log("\nSeed complete.");
  console.log("No social accounts or posts were created: connect real accounts to publish.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
