/**
 * Environment access with validation.
 *
 * Everything that reads process.env goes through this module so that a missing
 * or malformed variable fails loudly at boot instead of producing a confusing
 * runtime error later (or, worse, silently falling back to an insecure default).
 */

import { z } from "zod";

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** A 32-byte key, base64 encoded. Rejects placeholders from .env.example. */
const secret32 = z.string().refine(
  (v) => {
    if (v.startsWith("replace-me")) return false;
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  },
  { message: "must be a base64-encoded 32-byte key (openssl rand -base64 32)" },
);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ORIGIN: z.url(),
  APP_URL: z.url(),
  PORT: z.coerce.number().int().positive().default(3010),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  SESSION_SECRET: secret32,
  TOKEN_ENCRYPTION_KEY: secret32,

  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanish.default(true),
  MEDIA_PUBLIC_BASE_URL: z.url(),

  FACEBOOK_ENABLED: booleanish.default(false),
  INSTAGRAM_ENABLED: booleanish.default(false),
  LINKEDIN_ENABLED: booleanish.default(false),
  X_ENABLED: booleanish.default(false),

  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_GRAPH_VERSION: z.string().default("v26.0"),

  LINKEDIN_CLIENT_ID: optionalString,
  LINKEDIN_CLIENT_SECRET: optionalString,
  LINKEDIN_VERSION: z.string().default("202601"),

  X_CLIENT_ID: optionalString,
  X_CLIENT_SECRET: optionalString,

  PUBLISH_QUEUE_NAME: z.string().default("cw-publish"),
  PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/**
 * Parse and cache the environment.
 *
 * Called lazily rather than at module import so that `next build` and unit tests
 * that never touch the database do not require a full production secret set.
 */
export function env(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Run the environment sanity checks once, at the point the environment is first
 * read. Called from the health route and from the worker on boot.
 */
export function assertEnvironment(): void {
  assertDatabaseMatchesEnvironment();
}

/** Test helper: clear the memoised environment. */
export function resetEnvCache(): void {
  cached = null;
}

export function isProduction(): boolean {
  return env().NODE_ENV === "production";
}

export function isTest(): boolean {
  return env().NODE_ENV === "test";
}

/**
 * Guard against the most damaging configuration mistake in this project: a test
 * run pointed at the development (or production) database, or a dev server
 * pointed at the test database that integration tests truncate.
 *
 * This actually happened during development, via a leaked DATABASE_URL in a
 * shell, and it cost an hour of chasing a "wrong password" that was really a
 * truncated database. The check is on the database name, which is visible in the
 * connection string, rather than on a flag that can be forgotten.
 */
export function assertDatabaseMatchesEnvironment(): void {
  const config = env();
  checkDatabaseForEnvironment(config.NODE_ENV, config.DATABASE_URL);
}

/**
 * The guard itself, as a pure function of (environment, database url), so it can
 * be tested without mutating process.env — which some runtimes make impossible
 * for NODE_ENV.
 */
export function checkDatabaseForEnvironment(
  nodeEnv: "development" | "test" | "production",
  databaseUrl: string,
): { warn: string | null } {
  let databaseName: string;
  try {
    const parsed = new URL(databaseUrl);
    databaseName = parsed.pathname.replace(/^\//, "").split("?")[0] ?? "";
  } catch {
    throw new Error("DATABASE_URL is not a valid connection string.");
  }

  const looksLikeTestDb = databaseName.endsWith("_test");

  if (nodeEnv === "test" && !looksLikeTestDb) {
    throw new Error(
      `Refusing to run tests against database "${databaseName}": test runs must use a database whose name ends in "_test".`,
    );
  }

  if (nodeEnv === "production" && looksLikeTestDb) {
    throw new Error(`Refusing to start in production against test database "${databaseName}".`);
  }

  if (nodeEnv === "development" && looksLikeTestDb) {
    // Loud but non-fatal: a developer may legitimately want to inspect test data.
    const warning =
      `[env] The development server is connected to the test database "${databaseName}". ` +
      `Integration tests truncate it, so sign-in and data will disappear. Check DATABASE_URL.`;
    console.warn(warning);
    return { warn: warning };
  }

  return { warn: null };
}

/**
 * Platform capability flags.
 *
 * A platform is usable only when its flag is on AND its credentials are present.
 * This prevents the classic failure of a "enabled" integration that throws at
 * the first API call because the client secret was never set.
 */
export const platformFlags = {
  FACEBOOK: () => env().FACEBOOK_ENABLED && Boolean(env().META_APP_ID && env().META_APP_SECRET),
  INSTAGRAM: () => env().INSTAGRAM_ENABLED && Boolean(env().META_APP_ID && env().META_APP_SECRET),
  LINKEDIN: () =>
    env().LINKEDIN_ENABLED && Boolean(env().LINKEDIN_CLIENT_ID && env().LINKEDIN_CLIENT_SECRET),
  X: () => env().X_ENABLED && Boolean(env().X_CLIENT_ID && env().X_CLIENT_SECRET),
} as const;
