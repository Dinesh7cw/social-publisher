import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

/**
 * Diagnostic: print which database the app connects to and the admin's hash
 * prefix. Used to prove whether a test run is mutating the development database.
 */
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const rows = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  const users = await prisma.user.findMany({
    select: { email: true, role: true },
  });
  const admin = await prisma.user.findUnique({
    where: { email: "admin@colorwhistle.com" },
    select: { passwordHash: true, isActive: true },
  });

  console.log("DATABASE_URL host/db:", (process.env.DATABASE_URL ?? "").split("@")[1] ?? "(none)");
  console.log("current_database:", rows[0]?.current_database);
  console.log("users:", users.map((u) => `${u.email}:${u.role}`).join(", ") || "(none)");
  console.log("admin hash prefix:", admin?.passwordHash.slice(0, 32) ?? "(missing)");
  console.log("admin active:", admin?.isActive);
}

main().finally(() => prisma.$disconnect());
