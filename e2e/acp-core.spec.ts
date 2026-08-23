import { expect, test } from "@playwright/test";
import {
  closeOwnedSession,
  createOwnedSession,
  fixtureMethods,
  runnerProject,
} from "./helpers/harness";

const enabled = process.env.GROK_WEB_E2E_ISOLATED === "1";
test.skip(!enabled, "run through npm run test:e2e:acp");
test.describe("ACP core", () => {
  test.describe.configure({ mode: "serial" });

  test("New Task sends a marker through the real SSE gateway", async ({ page }) => {
    const cwd = runnerProject("a");
    await page.addInitScript(() => {
      const seen: string[] = [];
      const Original = window.EventSource;
      class RecordingEventSource extends Original {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          this.addEventListener("message", (event) => {
            try {
              const value = JSON.parse((event as MessageEvent).data);
              if (typeof value.type === "string") seen.push(value.type);
            } catch { /* non-JSON heartbeat */ }
          });
        }
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: RecordingEventSource });
      Object.defineProperty(window, "__e2eSseTypes", { configurable: true, value: seen });
    });
    await page.goto(`/?cwd=${encodeURIComponent(cwd)}`);
    try {
      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill("E2E_TEXT_MARKER");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("E2E_STREAM_OK", { exact: true })).toBeVisible();
      const types = await page.evaluate(() => (window as unknown as { __e2eSseTypes: string[] }).__e2eSseTypes);
      expect(types).toContain("session_snapshot");
      expect(types).toContain("message_update");
      expect(fixtureMethods()).toEqual(expect.arrayContaining(["initialize", "session/new", "session/prompt"]));
    } finally {
      const sessions = await page.request.get("/api/sessions").then((response) => response.json());
      for (const session of sessions.sessions ?? []) {
        if (session.cwd === cwd) await page.request.delete(`/api/sessions/${encodeURIComponent(session.id)}`);
      }
    }
  });

  test("renders thinking and text as one settled assistant turn", async ({ page }) => {
    await page.addInitScript(() => {
      const updates: unknown[] = [];
      const Original = window.EventSource;
      class RecordingEventSource extends Original {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          this.addEventListener("message", (event) => {
            try { updates.push(JSON.parse((event as MessageEvent).data)); } catch { /* heartbeat */ }
          });
        }
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: RecordingEventSource });
      Object.defineProperty(window, "__e2eUpdates", { configurable: true, value: updates });
    });
    const sessionId = await createOwnedSession(page, runnerProject("a"));
    try {
      await page.goto(`/?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(runnerProject("a"))}`);
      await page.getByRole("textbox", { name: "Message" }).fill("E2E_THOUGHT_TEXT");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("E2E_STREAM_OK", { exact: true })).toBeVisible();
      const updates = await page.evaluate(() => (window as unknown as { __e2eUpdates: unknown[] }).__e2eUpdates);
      expect(updates.some((event) => {
        const value = event as { assistantMessageEvent?: { type?: string; delta?: string } };
        return value.assistantMessageEvent?.type === "thinking_delta" && value.assistantMessageEvent.delta === "E2E_THINKING";
      })).toBeTruthy();
    } finally {
      await closeOwnedSession(page, sessionId);
    }
  });

  test("renders a tool call, progress, and completed result", async ({ page }) => {
    const sessionId = await createOwnedSession(page, runnerProject("a"));
    try {
      await page.goto(`/?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(runnerProject("a"))}`);
      await page.getByRole("textbox", { name: "Message" }).fill("E2E_TOOL");
      await page.getByRole("button", { name: "Send" }).click();
      const processToggle = page.locator("button.chat-process-summary");
      await expect(processToggle).toBeVisible();
      await processToggle.click();
      await expect(page.getByText("bash", { exact: true })).toBeVisible();
      await expect(page.getByText("echo E2E_TOOL", { exact: true })).toBeVisible();
      await expect(processToggle).toContainText("Processed");
    } finally {
      await closeOwnedSession(page, sessionId);
    }
  });

  test("approves and denies permission requests from the actual dialog", async ({ page }) => {
    for (const [message, button] of [["E2E_APPROVAL", "Confirm"], ["E2E_APPROVAL", "Cancel"]] as const) {
      const sessionId = await createOwnedSession(page, runnerProject("a"));
      try {
        await page.goto(`/?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(runnerProject("a"))}`);
        await page.getByRole("textbox", { name: "Message" }).fill(message);
        await page.getByRole("button", { name: "Send" }).click();
        await expect(page.getByText("Grok needs permission", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: button, exact: true }).click();
        await expect(page.getByText("Grok needs permission", { exact: true })).toBeHidden();
        await expect.poll(() => fixtureMethods().filter((method) => method === "permission_response").length).toBeGreaterThan(0);
      } finally {
        await closeOwnedSession(page, sessionId);
      }
    }
  });

  test("stops a running turn and keeps the submitted draft recoverable", async ({ page }) => {
    const sessionId = await createOwnedSession(page, runnerProject("a"));
    try {
      await page.goto(`/?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(runnerProject("a"))}`);
      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill("E2E_PARTIAL");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("E2E_PAR", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
      await expect.poll(() => fixtureMethods().filter((method) => method === "session/cancel").length).toBeGreaterThan(0);
    } finally {
      await closeOwnedSession(page, sessionId);
    }
  });
});

