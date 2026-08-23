import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureSafeFailureScreenshot } from "./helpers/harness";

const screenshotPath = join(process.cwd(), "docs/images/operate-shell.png");
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const artifactDir = process.env.GROK_WEB_E2E_ARTIFACT_DIR;
  if (artifactDir) await captureSafeFailureScreenshot(page, `${artifactDir}/screenshot.png`).catch(() => undefined);
});

test("loads the operate shell in front of a live grok workspace", async ({ page }) => {
  const cwd = process.env.GROK_WEB_E2E_PROJECT_A;
  await page.goto(cwd ? `/?cwd=${encodeURIComponent(cwd)}` : "/");
  await expect(page).toHaveTitle(/Grok Web/);
  await expect(page.getByText("Grok Web", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /new task/i })).toBeVisible();
  await expect(page.getByLabel(/message/i)).toBeVisible({ timeout: 30_000 });

  if (process.env.GROK_WEB_UPDATE_SCREENSHOTS === "1") {
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, animations: "disabled" });
  }
});
