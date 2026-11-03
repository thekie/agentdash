import { expect, test } from "@playwright/test";
import { emptyServerUrl } from "../playwright.config.ts";

// biome-ignore lint/style/useNamingConvention: Playwright sets the name of this option.
test.use({ baseURL: emptyServerUrl });

test("without Dashboards the Owner sees how to connect an Agent", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No dashboards yet" })).toBeVisible();
  await expect(
    page.getByText(`claude mcp add --transport http agentdash ${emptyServerUrl}/mcp`),
  ).toBeVisible();
  await expect(page.getByText(`"args": [`)).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    `Listening on ${new URL(emptyServerUrl).host}`,
  );
});
