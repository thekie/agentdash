import { expect, test } from "@playwright/test";

test("the Owner opens agentdash in the browser", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "agentdash" })).toBeVisible();
});
