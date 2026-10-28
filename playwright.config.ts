import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration.
 *
 * The suite signs in once in a setup project and reuses that session everywhere
 * else, because the login endpoint is deliberately rate limited (10 attempts per
 * minute per IP). Tests must not fight a security control that is working.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3010",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Playwright owns the server's lifecycle so a run cannot leave a half-dead
    // process behind or kill one that another run is using.
    command: "pnpm dev",
    url: "http://localhost:3010/login",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: ".taste-skill/auth-state.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 768, height: 1024 },
        storageState: ".taste-skill/auth-state.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        storageState: ".taste-skill/auth-state.json",
      },
      dependencies: ["setup"],
    },
  ],
});
