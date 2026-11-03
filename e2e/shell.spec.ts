import { expect, test } from "@playwright/test";

test("the Owner lands on the first Area", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/finance");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("💶Finance");
  await expect(page.getByText("Money in and out")).toBeVisible();
});

test("the sidebar lists the whole Dashboard tree and marks the current Dashboard", async ({
  page,
}) => {
  await page.goto("/finance/budget");
  const nav = page.getByRole("navigation", { name: "Dashboards" });
  await expect(nav.getByRole("link")).toHaveText([
    "💶Finance",
    "🧾Budget",
    "🥦Groceries",
    "🏦Savings",
    "🫀Health",
  ]);
  await expect(nav.getByRole("link", { name: "Budget" })).toHaveAttribute("aria-current", "page");
});

test("the Owner moves through nested Dashboards with the sidebar and the breadcrumbs", async ({
  page,
}) => {
  await page.goto("/finance");
  await page
    .getByRole("navigation", { name: "Dashboards" })
    .getByRole("link", { name: "Groceries" })
    .click();
  await expect(page).toHaveURL("/finance/budget/groceries");
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("listitem")).toHaveText(["💶Finance", "🧾Budget", "Groceries"]);
  await crumbs.getByRole("link", { name: "Budget" }).click();
  await expect(page).toHaveURL("/finance/budget");
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("🥦Groceries");
});

test("a Dashboard shows its Widgets in order, with layout Widgets holding theirs", async ({
  page,
}) => {
  await page.goto("/finance/budget");
  await expect(page.getByRole("heading", { level: 2, name: "This month" })).toBeVisible();
  const widgets = page.getByRole("region");
  await expect(widgets.getByRole("heading")).toHaveText(["Spent", "Tip", "Reminder"]);
  await expect(widgets.first().locator("time")).toHaveText("just now");
});

test("an unknown path says the Dashboard is missing", async ({ page }) => {
  await page.goto("/finance/nope");
  await expect(page.getByRole("heading", { name: "No such Dashboard" })).toBeVisible();
});
