import { expect, test } from "@playwright/test";
import { authorizeProject, captureSafeFailureScreenshot } from "./helpers/harness";

const enabled = process.env.GROK_WEB_LIVE_E2E === "1" && Boolean(process.env.GROK_WEB_LIVE_E2E_HOME);
test.skip(!enabled, "requires explicit GROK_WEB_LIVE_E2E=1 and dedicated authenticated GROK_WEB_LIVE_E2E_HOME");
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const artifactDir = process.env.GROK_WEB_E2E_ARTIFACT_DIR;
  if (artifactDir) await captureSafeFailureScreenshot(page, `${artifactDir}/screenshot.png`).catch(() => undefined);
});
test.describe.configure({ mode: "serial" });

test("runs one bounded authenticated Grok browser turn and verifies persisted history", async ({ page }) => {
  const cwd = process.env.GROK_WEB_E2E_PROJECT_A;
  if (!cwd) throw new Error("live runner did not provide a temporary Git cwd");
  await page.goto(`/?cwd=${encodeURIComponent(cwd)}`);
  await authorizeProject(page, cwd);
  const promptResponse = page.waitForResponse((response) => response.url().includes("/api/agent/") && !response.url().endsWith("/new") && response.request().method() === "POST");
  await page.getByRole("textbox", { name: "Message" }).fill("LIVE_E2E_MARKER");
  await page.getByRole("button", { name: "Send" }).click();
  const prompt = await promptResponse;
  expect(prompt.ok(), await prompt.text()).toBeTruthy();

  const sessions = await page.request.get("/api/sessions").then((response) => response.json());
  const owned = (sessions.sessions ?? []).find((session: { cwd?: string }) => session.cwd === cwd);
  expect(owned?.id).toBeTruthy();
  const sessionId = owned.id as string;
  try {
    const context = await page.request.get(`/api/sessions/${encodeURIComponent(sessionId)}/context`);
    expect(context.ok(), await context.text()).toBeTruthy();
    const body = await context.json();
    expect(JSON.stringify(body)).toContain("LIVE_E2E_MARKER");

    await page.reload();
    await expect(page.getByText("LIVE_E2E_MARKER", { exact: true })).toBeVisible();
    for (const route of ["/api/mcp", "/api/plugins"]) {
      const response = await page.request.get(`${route}?cwd=${encodeURIComponent(cwd)}`);
      if (response.status() === 200) expect(await response.json()).toBeTruthy();
    }
  } finally {
    const abort = await page.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, { data: { type: "abort" }, timeout: 5_000 });
    expect([200, 404], await abort.text()).toContain(abort.status());
    const deleted = await page.request.delete(`/api/sessions/${encodeURIComponent(sessionId)}`, { timeout: 5_000 });
    expect([200, 404], await deleted.text()).toContain(deleted.status());
    const remaining = await page.request.get("/api/sessions").then((response) => response.json());
    expect((remaining.sessions ?? []).some((session: { id?: string; cwd?: string }) => session.id === sessionId || session.cwd === cwd)).toBe(false);
  }
});
