import { expect, test } from "@playwright/test";
import {
  authorizeProject,
  closeOwnedSession,
  createOwnedSession,
  fixtureEntries,
  fixtureMethods,
  releaseFixture,
  runnerProject,
} from "./helpers/harness";

const enabled = process.env.GROK_WEB_E2E_ISOLATED === "1";
test.skip(!enabled, "run through npm run test:e2e:acp");
test.describe("ACP recovery", () => {
  test.describe.configure({ mode: "serial" });

  test("reconnects after a partial message and finishes exactly once", async ({ page }) => {
    await page.addInitScript(() => {
      const sources: EventSource[] = [];
      let snapshotCount = 0;
      const Original = window.EventSource;
      class RecordingEventSource extends Original {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          sources.push(this);
          this.addEventListener("message", (event) => {
            try {
              const value = JSON.parse((event as MessageEvent).data);
              if (value.type === "session_snapshot") snapshotCount += 1;
            } catch { /* heartbeat */ }
          });
        }
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: RecordingEventSource });
      Object.defineProperty(window, "__forceE2eDisconnect", { configurable: true, value: () => sources.forEach((source) => { source.dispatchEvent(new Event("error")); source.close(); }) });
      Object.defineProperty(window, "__e2eSourceCount", { configurable: true, get: () => sources.length });
      Object.defineProperty(window, "__e2eSnapshotCount", { configurable: true, get: () => snapshotCount });
    });
    const sessionId = await createOwnedSession(page, runnerProject("b"));
    try {
      await page.goto(`/?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(runnerProject("b"))}`);
      await page.getByRole("textbox", { name: "Message" }).fill("E2E_PARTIAL");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("E2E_PAR", { exact: true })).toBeVisible();
      const snapshotCount = await page.evaluate(() => (window as unknown as { __e2eSnapshotCount: number }).__e2eSnapshotCount);
      await page.evaluate(() => (window as unknown as { __forceE2eDisconnect: () => void }).__forceE2eDisconnect());
      await expect.poll(() => page.evaluate(() => (window as unknown as { __e2eSnapshotCount: number }).__e2eSnapshotCount), { timeout: 15_000 }).toBeGreaterThan(snapshotCount);
      releaseFixture("release");
      await expect(page.getByText("E2E_PARTIAL_OK", { exact: true })).toBeVisible({ timeout: 15_000 });
      expect(await page.getByText("E2E_PARTIAL_OK", { exact: true }).count()).toBe(1);
    } finally {
      await closeOwnedSession(page, sessionId);
    }
  });

  test("two tabs show one approval and first response wins", async ({ page, browser }) => {
    const second = await browser.newPage();
    const sessionId = await createOwnedSession(page, runnerProject("a"));
    try {
      await page.goto(`/?cwd=${encodeURIComponent(runnerProject("a"))}`);
      const beforePermissions = fixtureMethods().filter((method) => method === "permission_response").length;
      await page.getByRole("textbox", { name: "Message" }).fill("E2E_APPROVAL");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("Grok needs permission", { exact: true })).toBeVisible();
      await second.goto(`/?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(runnerProject("a"))}`);
      const secondPending = await second.evaluate((id) => new Promise<string>((resolve, reject) => {
        const source = new EventSource(`/api/agent/${encodeURIComponent(id)}/events`);
        const timer = setTimeout(() => { source.close(); reject(new Error("second tab pending permission timeout")); }, 15_000);
        source.onmessage = (event) => {
          const value = JSON.parse(event.data);
          const pending = value.pendingPermissions?.[0]?.id;
          if (value.type === "session_snapshot" && typeof pending === "string") {
            clearTimeout(timer);
            source.close();
            resolve(pending);
          }
        };
      }), sessionId);
      expect(secondPending).toMatch(/^\d+$/);
      void page.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, {
        data: { type: "extension_ui_response", id: secondPending, confirmed: true },
      });
      await expect.poll(() => fixtureMethods().filter((method) => method === "permission_response").length).toBe(beforePermissions + 1);
      const lateResponse = await second.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, {
        data: { type: "extension_ui_response", id: secondPending, cancelled: true },
        timeout: 5_000,
      });
      expect(lateResponse.status()).toBe(409);
    } finally {
      await page.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, { data: { type: "abort" }, timeout: 3_000 }).catch(() => undefined);
      await second.close();
      await page.request.delete(`/api/sessions/${encodeURIComponent(sessionId)}`, { timeout: 3_000 }).catch(() => undefined);
    }
  });

  test("routes project A and B workspace reads to distinct fixture sessions", async ({ page }) => {
    await page.goto("/");
    const before = fixtureEntries().length;
    for (const cwd of [runnerProject("a"), runnerProject("b")]) {
      await authorizeProject(page, cwd);
      const mcp = await page.request.get(`/api/mcp?cwd=${encodeURIComponent(cwd)}`);
      const plugins = await page.request.get(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
      expect(mcp.ok(), await mcp.text()).toBeTruthy();
      expect(plugins.ok(), await plugins.text()).toBeTruthy();
    }
    const entries = fixtureEntries().slice(before).filter((entry) => ["_x.ai/mcp/list", "_x.ai/plugins/list"].includes(String(entry.method)));
    expect(new Set(entries.map((entry) => entry.cwdAlias)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(entries.map((entry) => entry.sessionId)).size).toBeGreaterThanOrEqual(2);
  });

  test("accepts advertised off/high modes and rolls back unsupported mode", async ({ page }) => {
    const sessionId = await createOwnedSession(page, runnerProject("a"));
    try {
      await page.goto(`/?cwd=${encodeURIComponent(runnerProject("a"))}`);
      await page.getByRole("textbox", { name: "Message" }).fill("E2E_TEXT_MARKER");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("E2E_STREAM_OK", { exact: true })).toBeVisible();
      const effort = page.getByRole("button", { name: "Change effort" });
      await expect(effort).toBeVisible();
      await effort.click();
      await expect(page.getByText("Off", { exact: true })).toBeVisible();
      await page.getByText("Off", { exact: true }).click();
      await expect.poll(() => fixtureMethods().filter((method) => method === "session/set_mode").length).toBeGreaterThan(0);
      const response = await page.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, { data: { type: "set_thinking_level", level: "max" } });
      expect(response.ok()).toBeFalsy();
      await expect(effort).toContainText("Off");
    } finally {
      await closeOwnedSession(page, sessionId);
    }
  });
});
