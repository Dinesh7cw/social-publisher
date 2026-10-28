/**
 * Test environment.
 *
 * Runs before every test file. It supplies deterministic secrets so crypto tests
 * are reproducible, and points at the dev infrastructure containers. The
 * database is not touched here; integration tests reset it themselves.
 */

// Vitest sets NODE_ENV=test itself; asserting it here is unnecessary.
process.env.APP_ORIGIN = "http://localhost:3010";
process.env.APP_URL = "http://localhost:3010";
process.env.PORT = "3010";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cw:cw_dev_password@localhost:55440/cw_social_test?schema=public";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:56390";

// Fixed 32-byte keys: base64 of a repeating pattern. Never used outside tests.
process.env.SESSION_SECRET = Buffer.alloc(32, 1).toString("base64");
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");

process.env.S3_ENDPOINT = "http://localhost:9010";
process.env.S3_REGION = "us-east-1";
process.env.S3_BUCKET = "cw-social";
process.env.S3_ACCESS_KEY_ID = "cw_minio";
process.env.S3_SECRET_ACCESS_KEY = "cw_minio_password";
process.env.S3_FORCE_PATH_STYLE = "true";
process.env.MEDIA_PUBLIC_BASE_URL = "http://localhost:9010/cw-social-public";

process.env.FACEBOOK_ENABLED = "false";
process.env.INSTAGRAM_ENABLED = "false";
process.env.LINKEDIN_ENABLED = "false";
process.env.X_ENABLED = "false";

process.env.META_GRAPH_VERSION = "v26.0";
process.env.LINKEDIN_VERSION = "202601";

process.env.PUBLISH_QUEUE_NAME = "cw-publish-test";
process.env.PUBLISH_MAX_ATTEMPTS = "5";
process.env.WORKER_CONCURRENCY = "1";

// Suppress pino output during tests; only failures should be noisy.
process.env.LOG_LEVEL = "silent";
