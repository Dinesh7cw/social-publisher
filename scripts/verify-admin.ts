import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { verifyPassword } from "../src/server/auth/password.js";

/**
 * Verify the seeded admin can actually sign in.
 *
 * Prints only a boolean and the hash parameters — never the hash or the password.
 */
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const database = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  const admin = await prisma.user.findUnique({
    where: { email: process.env.SEED_ADMIN_EMAIL ?? "admin@colorwhistle.com" },
    select: { passwordHash: true, isActive: true, role: true },
  });

  console.log("current_database:", database[0]?.current_database);
  console.log("admin exists:", Boolean(admin));
  console.log("admin active:", admin?.isActive);

  if (admin) {
    const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe!2026";
    const ok = await verifyPassword(admin.passwordHash, password);
    console.log("seeded password verifies:", ok);
  }
}

main().finally(() => prisma.$disconnect());
