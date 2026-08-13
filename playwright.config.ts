import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4175",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PLAYWRIGHT_USE_SYSTEM_CHROME ? "chrome" : undefined,
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
