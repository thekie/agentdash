import { defineConfig, devices } from "@playwright/test";

const port = 4399;

export default defineConfig({
  testDir: "e2e",
  globalTimeout: 5 * 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node src/main.ts --port ${port} --data-dir .data/e2e`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
