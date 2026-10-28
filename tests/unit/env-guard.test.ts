import { describe, expect, it, afterEach } from "vitest";

import { env, resetEnvCache, checkDatabaseForEnvironment } from "@/lib/env";

/**
 * The database/environment guard.
 *
 * A leaked DATABASE_URL once pointed the dev server at the test database, which
 * integration tests truncate. That produced a "wrong password" bug that was
 * really a wiped database, and cost real debugging time. These tests pin the
 * guard that now prevents it.
 *
 * `checkDatabaseForEnvironment` is a pure function of (environment, url) so it can
 * be tested without mutating NODE_ENV, which is read-only in this runtime.
 */

describe("environment validation", () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
    resetEnvCache();
  });

  it("rejects a placeholder encryption key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "replace-me-with-32-bytes-base64";
    resetEnvCache();

    expect(() => env()).toThrow(/32-byte key/);
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    resetEnvCache();

    expect(() => env()).toThrow(/32-byte key/);
  });
});

describe("database/environment guard", () => {
  const url = (name: string) => `postgresql://cw:pw@localhost:55440/${name}?schema=public`;

  it("refuses to run tests against a non-test database", () => {
    expect(() => checkDatabaseForEnvironment("test", url("cw_social"))).toThrow(
      /must use a database whose name ends in "_test"/,
    );
  });

  it("refuses to run production against a test database", () => {
    expect(() => checkDatabaseForEnvironment("production", url("cw_social_test"))).toThrow(
      /production against test database/,
    );
  });

  it("allows a test run against a test database", () => {
    expect(() => checkDatabaseForEnvironment("test", url("cw_social_test"))).not.toThrow();
  });

  it("allows development against the development database", () => {
    expect(() => checkDatabaseForEnvironment("development", url("cw_social"))).not.toThrow();
  });

  it("warns, but does not fail, when development points at the test database", () => {
    const result = checkDatabaseForEnvironment("development", url("cw_social_test"));
    expect(result.warn).toMatch(/test database/);
  });

  it("rejects a malformed connection string", () => {
    expect(() => checkDatabaseForEnvironment("development", "not-a-url")).toThrow(
      /valid connection string/,
    );
  });

  it("handles a database name with a query string", () => {
    expect(() =>
      checkDatabaseForEnvironment("test", "postgresql://u:p@h:5432/cw_social_test?schema=public"),
    ).not.toThrow();
  });
});
