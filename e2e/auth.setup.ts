import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Sign in once, reuse the session.
 *
 * The login endpoint is rate limited to 10 attempts per minute per IP, which is a
 * security control the suite must not fight. Signing in once and storing the
 * cookie is both the correct Playwright pattern and the only way to test the
 * app's real behaviour without tripping that control.
 */

const EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@colorwhistle.com";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe!2026";
const STATE_PATH = path.join(".taste-skill", "auth-state.json");

setup("authenticate", async ({ page }) => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });

  await page.goto("/login");
  await page.getByLabel("Work email").fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({
    timeout: 20_000,
  });

  await page.context().storageState({ path: STATE_PATH });
});
