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
  let sessionId: string | undefined;
  try {
    await page.goto(`/?cwd=${encodeURIComponent(cwd)}`);
    await authorizeProject(page, cwd);
    const newSessionResponse = page.waitForResponse((response) => response.url().endsWith("/api/agent/new") && response.request().method() === "POST");
    const promptResponse = page.waitForResponse((response) => response.url().includes("/api/agent/") && !response.url().endsWith("/new") && response.request().method() === "POST");
    await page.getByRole("textbox", { name: "Message" }).fill("LIVE_E2E_MARKER");
    await page.getByRole("button", { name: "Send" }).click();
    sessionId = (await newSessionResponse.then((response) => response.json())).sessionId as string;
    expect(sessionId).toBeTruthy();
    const liveSse = page.evaluate((id) => new Promise<{ updates: number; textUpdates: number; settled: boolean }>((resolve, reject) => {
      const source = new EventSource(`/api/agent/${encodeURIComponent(id)}/events`);
      let updates = 0;
      let textUpdates = 0;
      const timer = setTimeout(() => { source.close(); reject(new Error("live SSE completion timeout")); }, 120_000);
      source.onmessage = (event) => {
        const value = JSON.parse(event.data);
        if (value.type === "message_update") {
          updates += 1;
          if (value.assistantMessageEvent?.type === "text_delta" && typeof value.assistantMessageEvent.delta === "string" && value.assistantMessageEvent.delta) textUpdates += 1;
        }
        if (value.type === "agent_settled") {
          clearTimeout(timer);
          source.close();
          resolve({ updates, textUpdates, settled: true });
        }
      };
      source.onerror = () => { clearTimeout(timer); source.close(); reject(new Error("live SSE closed")); };
    }), sessionId);
    const prompt = await promptResponse;
    expect(prompt.ok(), await prompt.text()).toBeTruthy();
    const stream = await liveSse;
    expect(stream.settled).toBe(true);
    expect(stream.updates).toBeGreaterThan(0);
    expect(stream.textUpdates).toBeGreaterThan(0);

    const context = await page.request.get(`/api/sessions/${encodeURIComponent(sessionId!)}/context`);
    expect(context.ok(), await context.text()).toBeTruthy();
    expect(JSON.stringify(await context.json())).toContain("LIVE_E2E_MARKER");

    await page.reload();
    await expect(page.getByText("LIVE_E2E_MARKER", { exact: true })).toBeVisible();
    for (const route of ["/api/mcp", "/api/plugins"]) {
      const response = await page.request.get(`${route}?cwd=${encodeURIComponent(cwd)}`);
      if (response.status() === 200) expect(await response.json()).toBeTruthy();
    }
  } finally {
    let cleanupError: unknown;
    let sessions: { id?: string; cwd?: string }[] = [];
    try {
      const body = await page.request.get("/api/sessions").then((response) => response.json());
      sessions = body.sessions ?? [];
    } catch (error) {
      cleanupError = error;
    }
    const ownedIds = new Set<string>();
    for (const session of sessions) {
      if ((sessionId && session.id === sessionId) || session.cwd === cwd) ownedIds.add(String(session.id));
    }
    if (sessionId) ownedIds.add(sessionId);
    for (const ownedId of ownedIds) {
      try {
        const abort = await page.request.post(`/api/agent/${encodeURIComponent(ownedId)}`, { data: { type: "abort" }, timeout: 5_000 });
        expect([200, 404], await abort.text()).toContain(abort.status());
        const deleted = await page.request.delete(`/api/sessions/${encodeURIComponent(ownedId)}`, { timeout: 5_000 });
        expect([200, 404], await deleted.text()).toContain(deleted.status());
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      const remaining = await page.request.get("/api/sessions").then((response) => response.json());
      if ((remaining.sessions ?? []).some((session: { id?: string; cwd?: string }) => ownedIds.has(String(session.id)) || session.cwd === cwd)) {
        cleanupError ??= new Error(`Live E2E session residue remains under ${cwd}`);
      }
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  }
});
