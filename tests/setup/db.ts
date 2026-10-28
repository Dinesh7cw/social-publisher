/**
 * Integration tests.
 *
 * These run against the real Postgres and Redis from docker-compose, because the
 * things most worth testing here — transactional claims, unique constraints, and
 * job persistence — only exist in the real thing. A mocked database would pass
 * tests that the system could fail in production.
 *
 * Requires: docker compose up -d
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { hashPassword } from "@/server/auth/password";

let testClient: PrismaClient | null = null;

/**
 * A dedicated Prisma client for tests.
 *
 * The app's singleton is bound to the same database, but tests need to truncate
 * between cases without disturbing module state.
 */
export function testDb(): PrismaClient {
  if (!testClient) {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    testClient = new PrismaClient({ adapter });
  }
  return testClient;
}

/**
 * Truncate every table before each test.
 *
 * `TRUNCATE ... CASCADE` is used because the schema has restrictive foreign keys
 * that would otherwise refuse a plain delete.
 */
export async function resetDatabase(): Promise<void> {
  const db = testDb();

  // A hard stop before anything is truncated. These tests wipe every table, so
  // pointing them at a real database would destroy it. The check is on the
  // database name rather than a flag, because a flag is exactly what gets
  // forgotten when someone copies a .env around.
  const databaseName = await db.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  const name = databaseName[0]?.current_database ?? "";

  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to truncate "${name}": integration tests only run against a database whose name ends in "_test". ` +
        `Set TEST_DATABASE_URL or create cw_social_test.`,
    );
  }

  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog",
      "IdempotencyRecord",
      "PublishingAttempt",
      "ScheduledJob",
      "PostMedia",
      "PostTarget",
      "Post",
      "MediaAsset",
      "SocialAccountSecret",
      "SocialAccount",
      "ConnectSession",
      "OAuthState",
      "Client",
      "Session",
      "User"
    RESTART IDENTITY CASCADE;
  `);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  if (testClient) {
    await testClient.$disconnect();
    testClient = null;
  }
});

/** Create an admin user for a test. */
export async function makeUser(overrides: {
  email?: string;
  name?: string;
  role?: "ADMIN" | "MEMBER";
  password?: string;
} = {}) {
  const db = testDb();
  const password = overrides.password ?? "TestPassword123!";
  const passwordHash = await hashPassword(password);

  const user = await db.user.create({
    data: {
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2, 8)}@colorwhistle.com`,
      name: overrides.name ?? "Test User",
      passwordHash,
      role: overrides.role ?? "ADMIN",
      timeZone: "Asia/Kolkata",
    },
  });

  return { user, password };
}

/** Create two clients with one social account each, for cross-client tests. */
export async function makeTwoClientsWithAccounts() {
  const db = testDb();
  const { user } = await makeUser();

  const clientA = await db.client.create({
    data: { name: "ColorWhistle", slug: "colorwhistle", createdById: user.id },
  });
  const clientB = await db.client.create({
    data: { name: "Sri Krishna", slug: "sri-krishna", createdById: user.id },
  });

  const accountA = await db.socialAccount.create({
    data: {
      clientId: clientA.id,
      platform: "FACEBOOK",
      externalId: "page-a",
      displayName: "CW Page",
      accountType: "PAGE",
      status: "CONNECTED",
      scopes: ["pages_manage_posts"],
      connectedById: user.id,
    },
  });

  const accountB = await db.socialAccount.create({
    data: {
      clientId: clientB.id,
      platform: "FACEBOOK",
      externalId: "page-b",
      displayName: "SK Page",
      accountType: "PAGE",
      status: "CONNECTED",
      scopes: ["pages_manage_posts"],
      connectedById: user.id,
    },
  });

  return { user, clientA, clientB, accountA, accountB };
}

beforeAll(() => {
  // Fail fast with a useful message when infrastructure is not running.
  if (!process.env.DATABASE_URL) {
    throw new Error("Integration tests need DATABASE_URL. Run `docker compose up -d`.");
  }
});
