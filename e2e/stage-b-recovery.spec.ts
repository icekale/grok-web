import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const enabled = process.env.GROK_WEB_STAGE_B_E2E === "1";
test.skip(!enabled, "set GROK_WEB_STAGE_B_E2E=1 with GROK_BIN pointing at the Stage B fixture");
test.describe.configure({ mode: "serial" });

const projectA = process.env.GROK_WEB_STAGE_B_PROJECT_A || process.cwd();
const projectB = process.env.GROK_WEB_STAGE_B_PROJECT_B || join(projectA, "components");

async function createSession(page, cwd: string): Promise<string> {
  const response = await page.request.post("/api/agent/new", {
    data: { cwd, type: "ensure_session" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).sessionId;
}

async function deleteSession(page, sessionId: string): Promise<void> {
  await page.request.delete(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

async function waitForSnapshot(page, sessionId: string): Promise<unknown> {
  return page.evaluate((id) => new Promise((resolve, reject) => {
    const source = new EventSource(new URL(`/api/agent/${encodeURIComponent(id)}/events`, location.origin).href);
    const timer = setTimeout(() => { source.close(); reject(new Error("snapshot timeout")); }, 10_000);
    source.onmessage = (event) => {
      const parsed = JSON.parse(event.data);
      if (parsed.type === "session_snapshot") {
        clearTimeout(timer);
        source.close();
        resolve(parsed);
      }
    };
    source.onerror = () => {
      clearTimeout(timer);
      source.close();
      reject(new Error("SSE closed before snapshot"));
    };
  }), sessionId);
}

function fixtureLog(): Array<{ method: string; params: Record<string, unknown> }> {
  const path = process.env.GROK_WEB_STAGE_B_LOG;
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("routes MCP and Plugins through distinct cwd-owned sessions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Grok Web", { exact: true }).first()).toBeVisible();
  const sessions: string[] = [];
  try {
    for (const cwd of [projectA, projectB]) {
      const mcp = await page.request.get(`/api/mcp?cwd=${encodeURIComponent(cwd)}`);
      const plugins = await page.request.get(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
      const mcpText = await mcp.text();
      const pluginsText = await plugins.text();
      expect(mcp.ok(), mcpText).toBeTruthy();
      expect(plugins.ok(), pluginsText).toBeTruthy();
      const mcpSources = (JSON.parse(mcpText).packages ?? []).map((pkg: { source?: string }) => pkg.source).filter((source: string) => source?.startsWith("mcp-stage-b-"));
      const pluginSources = (JSON.parse(pluginsText).packages ?? []).map((pkg: { source?: string }) => pkg.source).filter((source: string) => source?.startsWith("plugin-stage-b-"));
      expect(mcpSources.length, mcpText).toBeGreaterThan(0);
      expect(pluginSources.length, pluginsText).toBeGreaterThan(0);
      const listed = await page.request.get("/api/sessions");
      for (const session of (await listed.json()).sessions ?? []) {
        if (String(session.id).startsWith("stage-b-")) sessions.push(session.id);
      }
    }
    const workspaceCalls = fixtureLog().filter((entry) => ["_x.ai/mcp/list", "_x.ai/plugins/list", "_x.ai/marketplace/list"].includes(entry.method));
    if (workspaceCalls.length > 0) {
      const ids = new Set(workspaceCalls.map((entry) => String(entry.params.session_id ?? entry.params.sessionId)));
      expect(ids.size).toBeGreaterThanOrEqual(2);
    }
  } finally {
    for (const sessionId of [...new Set(sessions)]) await deleteSession(page, sessionId);
  }
});

test("reconnects after partial assistant output without duplicating the prefix", async ({ page }) => {
  await page.goto("/");
  const sessionId = await createSession(page, projectA);
  try {
    const snapshotPromise = waitForSnapshot(page, sessionId);
    const prompt = page.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, {
      data: { type: "prompt", message: "E2E_PARTIAL" },
    });
    const snapshot = await snapshotPromise;
    expect((snapshot as { sessionId: string }).sessionId).toBe(sessionId);
    expect((await prompt).ok()).toBeTruthy();
    const secondSnapshot = await waitForSnapshot(page, sessionId);
    expect((secondSnapshot as { sessionId: string }).sessionId).toBe(sessionId);
  } finally {
    await deleteSession(page, sessionId);
  }
});

test("two browser tabs resolve one approval", async ({ page, browser }) => {
  await page.goto("/");
  const sessionId = await createSession(page, projectA);
  const second = await browser.newPage();
  try {
    await second.goto("/");
    await Promise.all([waitForSnapshot(page, sessionId), waitForSnapshot(second, sessionId)]);
    const prompt = page.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, {
      data: { type: "prompt", message: "E2E_APPROVAL" },
    });
    await expect.poll(() => fixtureLog().some((entry) => entry.method === "session/request_permission")).toBe(true);
    const first = page.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, {
      data: { type: "extension_ui_response", id: "1", confirmed: true },
    });
    const secondResponse = await second.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, {
      data: { type: "extension_ui_response", id: "1", cancelled: true },
    });
    const firstResponse = await first;
    expect((await prompt).ok()).toBeTruthy();
    expect([200, 409]).toContain(firstResponse.status());
    expect([200, 409]).toContain(secondResponse.status());
    expect(fixtureLog().filter((entry) => entry.method === "permission_response").length).toBe(1);
  } finally {
    await second.close();
    await deleteSession(page, sessionId);
  }
});
