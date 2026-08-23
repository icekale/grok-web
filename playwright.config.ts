import { defineConfig, devices } from "@playwright/test";

const isolated = process.env.GROK_WEB_E2E_ISOLATED === "1";
const port = Number(process.env.GROK_WEB_E2E_PORT || 30143);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    trace: "off",
    screenshot: "off",
    video: "off",
    outputDir: process.env.GROK_WEB_E2E_RAW_OUTPUT_DIR,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite dev --configLoader runner --config vite.tanstack.config.ts --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: isolated ? false : !process.env.CI,
    timeout: 120_000,
  },
});
