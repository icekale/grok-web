import { expect, type Page } from "@playwright/test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export function runnerProject(cwd: "a" | "b"): string {
  return cwd === "a" ? process.env.GROK_WEB_E2E_PROJECT_A || process.cwd() : process.env.GROK_WEB_E2E_PROJECT_B || process.cwd();
}

export async function authorizeProject(page: Page, cwd: string): Promise<void> {
  const response = await page.request.post("/api/cwd/validate", { data: { cwd } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

export async function createOwnedSession(page: Page, cwd: string): Promise<string> {
  await authorizeProject(page, cwd);
  const response = await page.request.post("/api/agent/new", { data: { cwd, type: "ensure_session" } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).sessionId as string;
}

export async function closeOwnedSession(page: Page, sessionId: string): Promise<void> {
  const response = await page.request.delete(`/api/sessions/${encodeURIComponent(sessionId)}`);
  expect([200, 404], await response.text()).toContain(response.status());
}

export function releaseFixture(command = "release"): void {
  const path = process.env.GROK_WEB_ACP_FIXTURE_CONTROL;
  if (path) writeFileSync(path, `${command}\n`);
}

export function fixtureEntries(): Array<Record<string, unknown>> {
  const path = process.env.GROK_WEB_ACP_FIXTURE_LOG;
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function fixtureMethods(testId = "deterministic-acp"): string[] {
  return fixtureEntries().filter((entry) => entry.testId === testId).map((entry) => String(entry.method));
}

export async function waitForSseType(page: Page, sessionId: string, wantedType: string): Promise<unknown> {
  return page.evaluate(({ id, type }) => new Promise((resolve, reject) => {
    const source = new EventSource(`/api/agent/${encodeURIComponent(id)}/events`);
    const timer = setTimeout(() => { source.close(); reject(new Error(`${type} timeout`)); }, 15_000);
    source.onmessage = (event) => {
      const value = JSON.parse(event.data);
      if (value.type === type) {
        clearTimeout(timer);
        source.close();
        resolve(value);
      }
    };
    source.onerror = () => { clearTimeout(timer); source.close(); reject(new Error(`SSE closed before ${type}`)); };
  }), { id: sessionId, type: wantedType });
}

export async function sanitizePageForScreenshot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const placeholder = "E2E_SAFE";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) textNodes.push(node as Text);
    for (const text of textNodes) if (text.data.trim()) text.data = placeholder;
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) input.value = placeholder;
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      for (const name of ["src", "href", "action", "poster", "data", "srcset", "style"]) element.removeAttribute(name);
      element.removeAttribute("aria-label");
      element.removeAttribute("title");
    }
    for (const media of document.querySelectorAll("img, svg, canvas, video, iframe")) media.replaceChildren();
    const style = document.createElement("style");
    style.textContent = "*::before,*::after{content:none!important;background:none!important;background-image:none!important} *,*::marker{background:none!important;background-image:none!important;list-style-image:none!important} img,svg,canvas,video,iframe{visibility:hidden!important}";
    document.head.append(style);
    document.documentElement.setAttribute("data-e2e-safe-screenshot", "1");
  });
}

export async function captureSafeFailureScreenshot(page: Page, path: string): Promise<void> {
  await sanitizePageForScreenshot(page);
  expect(await page.locator("html").getAttribute("data-e2e-safe-screenshot")).toBe("1");
  await page.screenshot({ path, animations: "disabled" });
  appendFileSync(path, "E2E_SAFE_SCREENSHOT_V1\n");
}

export function appendChronology(path: string, event: Record<string, unknown>): void {
  const safe = { method: String(event.method || "unknown"), status: Number(event.status || 0), testId: String(event.testId || "deterministic-acp") };
  appendFileSync(path, `${JSON.stringify(safe)}\n`);
}
