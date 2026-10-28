/**
 * Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter; the connection string is no longer read
 * from schema.prisma. In development Next.js hot-reloads modules, so the client
 * is stashed on globalThis to avoid exhausting the connection pool with a new
 * pool per reload.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env().DATABASE_URL,
    max: env().NODE_ENV === "production" ? 20 : 10,
  });

  return new PrismaClient({
    adapter,
    log:
      env().NODE_ENV === "development"
        ? [{ emit: "event", level: "error" }, { emit: "event", level: "warn" }]
        : [{ emit: "event", level: "error" }],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (env().NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Types re-exported for convenience so callers do not reach into the generated
 * folder directly and break when the output path changes.
 */
export type {
  User,
  Client,
  SocialAccount,
  Post,
  PostTarget,
  MediaAsset,
  PublishingAttempt,
  AuditLog,
  ScheduledJob,
} from "@/generated/prisma/client";

export {
  Role,
  ClientStatus,
  Platform,
  AccountType,
  AccountStatus,
  PostStatus,
  TargetStatus,
  MediaKind,
  JobState,
  AttemptOutcome,
  AuditAction,
} from "@/generated/prisma/enums";
