import { defineConfig, devices } from "@playwright/test";
import { HOST } from "./src/options.ts";

const port = 4399;

export default defineConfig({
  testDir: "e2e",
  globalTimeout: 5 * 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI && { workers: 1 }),
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // biome-ignore lint/style/useNamingConvention: Playwright sets the name of this option.
  use: { baseURL: `http://${HOST}:${port}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -rf .data/e2e && node src/main.ts --port ${port} --data-dir .data/e2e`,
    url: `http://${HOST}:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
