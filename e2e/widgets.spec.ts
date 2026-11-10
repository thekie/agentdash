import { expect, type Page, test } from "@playwright/test";

const widget = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("a kpi with an x Slot shows the latest value and the change from the one before", async ({
  page,
}) => {
  await page.goto("/finance/savings");
  const kpi = widget(page, "Balance");
  await expect(kpi.locator(".big")).toHaveText("€21,050");
  await expect(kpi.locator(".chip")).toHaveText("↑ €750");
  await expect(kpi.locator(".chip")).toHaveClass(/good/);
});

test("a progress Widget without a label shows the share of its target", async ({ page }) => {
  await page.goto("/finance/savings");
  const progress = widget(page, "Emergency fund");
  await expect(progress.locator(".big")).toHaveText("70%");
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "70");
});

test("a labelled progress row over its target says how far, coloured by goodDirection", async ({
  page,
}) => {
  await page.goto("/finance/savings");
  const over = widget(page, "Category limits").getByText("35% over");
  await expect(over).toBeVisible();
  await expect(over).toHaveClass(/bad/);
});

test("a table shows the projected columns with formatted values", async ({ page }) => {
  await page.goto("/finance/savings");
  const table = widget(page, "Categories").getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["name", "spent", "limit"]);
  await expect(table.getByRole("row").nth(2).getByRole("cell")).toHaveText([
    "Leisure",
    "€270",
    "€200",
  ]);
});

for (const [name, label] of [
  ["Weight", "Line chart of kg, 4 Oct to 18 Oct"],
  ["Minutes per week", "Stacked bar chart of Run, Ride, W41 to W42"],
  ["Distance per week", "Bar chart of run, ride, W41 to W42"],
] as const) {
  test(`the ${name} chart draws as a ${label}`, async ({ page }) => {
    await page.goto("/health");
    await expect(widget(page, name).getByRole("img", { name: label })).toBeVisible();
  });
}

/** The font size an axis label is drawn at on screen, after any SVG scaling. */
const axisLabelSize = (page: Page, name: string) =>
  widget(page, name)
    .locator(".chart text")
    .first()
    .evaluate((t: SVGTextElement) => {
      const scale = t.getScreenCTM()?.a ?? 0;
      return Number.parseFloat(getComputedStyle(t).fontSize) * scale;
    });

for (const colorScheme of ["light", "dark"] as const) {
  test(`a chart in columns draws axis labels at full size in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/health");
    expect(await axisLabelSize(page, "Weight")).toBe(12);
    expect(await axisLabelSize(page, "Weight, half width")).toBe(12);
  });
}

test("hovering a stacked bar shows its total and each series", async ({ page }) => {
  await page.goto("/health");
  const chart = widget(page, "Minutes per week");
  await expect(chart.getByRole("listitem")).toHaveText(["Run", "Ride"]);
  await chart.locator(".plot").hover({ position: { x: 300, y: 100 } });
  await expect(chart.getByRole("tooltip")).toHaveText("W41210 minRun90 minRide120 min");
});

test("a checklist shows open items first, with their due dates", async ({ page }) => {
  await page.goto("/health");
  const list = widget(page, "This week");
  await expect(list.getByRole("listitem")).toHaveText([
    /^Book check-up.*Overdue/,
    /^Plan meals.*Due/,
    "Buy shoes",
  ]);
  await expect(list.getByText("1 of 3")).toBeVisible();
});

test("a checklist that hides done items counts them instead", async ({ page }) => {
  await page.goto("/health");
  const list = widget(page, "Habits");
  await expect(list.getByRole("listitem")).toHaveText(["Walk"]);
  await expect(list.getByText("1 done item hidden")).toBeVisible();
});

test("a note renders markdown and drops raw HTML", async ({ page }) => {
  await page.goto("/health");
  const note = widget(page, "Tips");
  await expect(note.locator("strong")).toHaveText("water");
  await expect(note.locator("del")).toHaveText("Skip");
  await expect(note.locator("b")).toHaveCount(0);
});

test("an external link in a note opens in a new tab", async ({ page }) => {
  await page.goto("/health");
  const link = widget(page, "Tips").getByRole("link", { name: "the guide ↗" });
  await expect(link).toHaveAttribute("target", "_blank");
});

test("a Dashboard link opens its target", async ({ page }) => {
  await page.goto("/finance");
  const link = page.getByRole("link", { name: /Savings.*Funds and holdings/ });
  await link.click();
  await expect(page).toHaveURL("/finance/savings");
});

for (const [name, text] of [
  ["Receipts", "No data yet"],
  ["Receipt list", "No data yetRows appear here as an Agent adds them."],
] as const) {
  test(`${name} without rows says ${text}`, async ({ page }) => {
    await page.goto("/finance/budget/groceries");
    await expect(widget(page, name)).toContainText(text);
  });
}

test("a broken Widget says why it cannot draw", async ({ page }) => {
  await page.goto("/finance/budget/groceries");
  await expect(widget(page, "Weekly km").getByRole("alert")).toContainText(
    'Cannot draw this WidgetUnknown output column "km". Ask an Agent to fix it.',
  );
});

test("a Widget on an Archived Data Store names it", async ({ page }) => {
  await page.goto("/finance/budget/groceries");
  await expect(widget(page, "Holdings")).toContainText("Data Store holdings was Archived.");
});

for (const [colorScheme, panel] of [
  ["light", "rgb(255, 255, 255)"],
  ["dark", "rgb(23, 26, 33)"],
] as const) {
  test(`Widgets follow the ${colorScheme} colour scheme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/finance/savings");
    await expect(widget(page, "Categories")).toHaveCSS("background-color", panel);
  });
}
