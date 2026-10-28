import { test, expect } from "@playwright/test";

/**
 * The calendar after its fetch restructure.
 *
 * The effect now writes state only from promise callbacks, so this test proves the
 * screen still loads and its month/week navigation still works end to end.
 */
test.describe("calendar behaviour", () => {
  test("loads and shows a month grid", async ({ page }) => {
    await page.goto("/calendar");

    await expect(page.getByRole("heading", { level: 1, name: "Content calendar" })).toBeVisible();

    // Wait for the skeleton to be replaced by the real grid.
    await expect(page.locator(".calendar-grid-skeleton")).toBeHidden({ timeout: 15_000 });
    await expect(page.locator(".calendar-cell").first()).toBeVisible();

    // A month view shows 42 cells (six weeks), even when empty.
    await expect(page.locator(".calendar-cell")).toHaveCount(42);
  });

  test("navigates to the next month and back", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page.locator(".calendar-grid-skeleton")).toBeHidden({ timeout: 15_000 });

    const heading = page.locator(".calendar-heading");
    const before = await heading.textContent();

    await page.getByRole("button", { name: "Next month" }).click();
    await expect(heading).not.toHaveText(before ?? "");

    await page.getByRole("button", { name: /Previous month/ }).click();
    await expect(heading).toHaveText(before ?? "");
  });

  test("switches to the week view", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page.locator(".calendar-grid-skeleton")).toBeHidden({ timeout: 15_000 });

    await page.getByRole("radio", { name: "Week" }).click();

    // A week view shows seven cells.
    await expect(page.locator(".calendar-cell")).toHaveCount(7, { timeout: 15_000 });
  });

  test("Today returns to the current month", async ({ page }) => {
    await page.goto("/calendar");
    await expect(page.locator(".calendar-grid-skeleton")).toBeHidden({ timeout: 15_000 });

    await page.getByRole("button", { name: "Next month" }).click();
    await page.getByRole("button", { name: "Today" }).click();

    const now = new Date();
    const expected = now.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    await expect(page.locator(".calendar-heading")).toHaveText(expected);
  });
});
