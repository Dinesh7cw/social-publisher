import { test, expect } from "@playwright/test";

/**
 * End-to-end over the real app.
 *
 * The session is created once by `auth.setup.ts` and reused, so these tests do not
 * hammer the rate-limited login endpoint.
 *
 * The unauthenticated checks run in a context with no stored session.
 */

const SCREENS = [
  { path: "/", name: "dashboard", heading: "Dashboard" },
  { path: "/clients", name: "clients", heading: "Clients" },
  { path: "/accounts", name: "accounts", heading: "Social accounts" },
  { path: "/compose", name: "compose", heading: "Create post" },
  { path: "/calendar", name: "calendar", heading: "Content calendar" },
  { path: "/history", name: "history", heading: "Publishing history" },
  { path: "/settings", name: "settings", heading: "Team settings" },
];

test.describe("unauthenticated access", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("redirects to the login screen", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { level: 2, name: "Sign in" })).toBeVisible();
  });

  test("closes the private API", async ({ request }) => {
    const response = await request.get("/api/dashboard");
    expect(response.status()).toBe(401);

    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("shows a generic message for a wrong password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Work email").fill("nobody@colorwhistle.com");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password-entirely");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Scoped to the form: Next's route announcer also carries role="alert".
    await expect(page.locator("#login-error")).toContainText(/incorrect/i);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("every screen renders", () => {
  for (const screen of SCREENS) {
    test(`${screen.name}`, async ({ page }, testInfo) => {
      await page.goto(screen.path);

      await expect(page.getByRole("heading", { level: 1, name: screen.heading })).toBeVisible();

      // Capture for the visual review, named by viewport.
      await page.waitForTimeout(350);
      await page.screenshot({
        path: `.taste-skill/screens/${testInfo.project.name}-${screen.name}.png`,
        fullPage: true,
      });
    });
  }
});

test.describe("dashboard content", () => {
  test("shows all six counters with honest zeros", async ({ page }) => {
    await page.goto("/");

    // Scoped to the totals strip: "Clients" also names a nav link, and the test
    // must target the counter rather than whichever element came first.
    const strip = page.getByRole("region", { name: "Publishing totals" });

    for (const label of [
      "Clients",
      "Connected accounts",
      "Drafts",
      "Scheduled",
      "Published",
      "Failed",
    ]) {
      await expect(strip.getByText(label, { exact: true })).toBeVisible();
    }

    // Six counters, each with a numeric value beside its label.
    await expect(strip.locator(".kpi")).toHaveCount(6);

    // The seeded clients exist, so the client count is a real number, not a dash.
    const clientValue = strip.locator(".kpi").first().locator(".kpi-value");
    await expect(clientValue).toHaveText(/^\d+$/);
    await expect(Number(await clientValue.textContent())).toBeGreaterThanOrEqual(2);

    // With nothing published yet, these read as an honest zero rather than a
    // dash or a blank.
    await expect(strip.locator(".kpi").nth(4).locator(".kpi-value")).toHaveText("0");
  });

  test("states the screen's finding under the title", async ({ page }) => {
    await page.goto("/");
    const sub = page.locator(".page-sub");
    await expect(sub).toBeVisible();
    await expect(sub).not.toBeEmpty();
  });
});

test.describe("client management", () => {
  test("creates a client and shows it in the list", async ({ page }) => {
    await page.goto("/clients");

    // A name that sorts last, so the run cannot change which client the composer
    // selects by default in a later test.
    const uniqueName = `ZZ E2E ${Date.now()}`;

    await page.getByRole("button", { name: "Add client" }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Client name").fill(uniqueName);

    // Submit with the keyboard: on a phone the dialog's footer is sticky, which
    // Playwright's pointer hit-testing sometimes refuses even though the button
    // is the topmost element at its centre (verified separately). Enter inside a
    // form is the same submission a keyboard user would make.
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("/api/clients") && res.request().method() === "POST",
      ),
      dialog.getByLabel("Client name").press("Enter"),
    ]);

    expect(
      response.status(),
      `POST /api/clients returned ${response.status()}: ${await response.text()}`,
    ).toBe(201);

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole("cell", { name: uniqueName })).toBeVisible({ timeout: 15_000 });

    // Leave the development database as we found it: archive what we created so
    // the run does not accumulate test clients that later tests then read.
    const created = (await response.json()) as { id: string };
    await page.request.post(`/api/clients/${created.id}/archive`, {
      headers: { Origin: "http://localhost:3010" },
      data: { restore: false },
    });
  });

  test("search narrows the list", async ({ page }) => {
    await page.goto("/clients");

    await page.getByPlaceholder("Search clients").fill("Sri Krishna");
    await expect(page.getByRole("cell", { name: "Sri Krishna" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("cell", { name: "ColorWhistle" })).toBeHidden();
  });
});

test.describe("composer", () => {
  test("is honest when a client has no accounts", async ({ page }) => {
    await page.goto("/compose");

    await expect(page.getByRole("heading", { level: 1, name: "Create post" })).toBeVisible();

    // Whichever client is selected first, the rail must say either that there are
    // no accounts or list real ones. It must never show an empty picker with no
    // explanation.
    const rail = page.locator(".composer-rail");
    const hasEmptyMessage = rail.getByText(/no connected accounts/i);
    const hasAccountRows = rail.locator(".account-row");

    const emptyVisible = await hasEmptyMessage.isVisible().catch(() => false);
    const rowCount = await hasAccountRows.count();

    expect(
      emptyVisible || rowCount > 0,
      "the account picker must explain an empty state or list real accounts",
    ).toBe(true);
  });

  test("does not invite a submission that cannot publish", async ({ page }) => {
    await page.goto("/compose");

    // With nothing selected the primary action is disabled, so the user is never
    // invited to submit something that cannot publish.
    const submit = page.getByRole("button", { name: /Save draft|Publish now|Schedule post/ });
    await expect(submit).toBeDisabled();
    await expect(page.getByText(/No accounts selected/i)).toBeVisible();
  });
});

test.describe("accounts", () => {
  test("explains which platforms are not configured instead of hiding them", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page.getByText("Not available yet")).toBeVisible();
  });
});

test.describe("phone navigation", () => {
  test.skip(({ isMobile }) => !isMobile, "Only meaningful on the phone viewport");

  test("the sidebar folds into a menu", async ({ page }) => {
    await page.goto("/");

    const menuButton = page.getByRole("button", { name: "Menu" });
    await expect(menuButton).toBeVisible();
    await menuButton.click();

    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

    await page.getByRole("link", { name: "Clients" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
  });
});
