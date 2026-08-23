import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { authorizeProject, captureSafeFailureScreenshot } from "./helpers/harness";

const enabled = process.env.GROK_WEB_LIVE_E2E === "1" && Boolean(process.env.GROK_WEB_LIVE_E2E_HOME);
test.skip(!enabled, "requires explicit GROK_WEB_LIVE_E2E=1 and dedicated authenticated GROK_WEB_LIVE_E2E_HOME");

function removeManagedWorktree(worktreePath: string): void {
  const home = process.env.GROK_WEB_LIVE_E2E_HOME;
  const binary = process.env.GROK_WEB_LIVE_E2E_GROK_BIN || process.env.GROK_BIN;
  if (!home || !binary) return;
  const listing = execFileSync(binary, ["worktree", "list"], { env: { ...process.env, GROK_HOME: home }, encoding: "utf8" });
  const suffix = basename(worktreePath);
  const line = listing.split(/\r?\n/).find((candidate) => candidate.includes(worktreePath) || candidate.trim().endsWith(suffix));
  const id = line?.trim().split(/\s+/)[0];
  if (id) execFileSync(binary, ["worktree", "rm", "-f", id], { env: { ...process.env, GROK_HOME: home }, stdio: "ignore" });
}

function removeManagedWorktreesForCwd(cwd: string): void {
  const home = process.env.GROK_WEB_LIVE_E2E_HOME;
  const binary = process.env.GROK_WEB_LIVE_E2E_GROK_BIN || process.env.GROK_BIN;
  if (!home || !binary) return;
  const marker = basename(join(cwd, ".."));
  const listing = execFileSync(binary, ["worktree", "list"], { env: { ...process.env, GROK_HOME: home }, encoding: "utf8" });
  for (const line of listing.split(/\r?\n/)) {
    if (!line.includes(marker)) continue;
    const id = line.trim().split(/\s+/)[0];
    if (id && id !== "ID") execFileSync(binary, ["worktree", "rm", "-f", id], { env: { ...process.env, GROK_HOME: home }, stdio: "ignore" });
  }
  rmSync(join(home, "worktrees", `${marker}-project`), { recursive: true, force: true });
}

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
    let profileBody: { profile: Record<string, unknown>; capabilities: { globalFlags?: string[] } } | undefined;
    if (process.env.GROK_WEB_LIVE_E2E_MUTATIONS === "1") {
      const profileResponse = await page.request.get("/api/runtime-profile");
      expect(profileResponse.ok(), await profileResponse.text()).toBeTruthy();
      profileBody = await profileResponse.json() as typeof profileBody;
      if (profileBody.capabilities.globalFlags?.includes("--permission-mode")) {
        const applied = await page.request.put("/api/runtime-profile", { data: profileBody.profile });
        expect(applied.ok(), await applied.text()).toBeTruthy();
      }
    }
    const newSessionResponse = page.waitForResponse((response) => response.url().endsWith("/api/agent/new") && response.request().method() === "POST");
    const promptResponse = page.waitForResponse((response) => {
      if (!response.url().includes("/api/agent/") || response.url().endsWith("/new") || response.request().method() !== "POST") return false;
      try { return response.request().postDataJSON()?.type === "prompt"; } catch { return false; }
    });
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

    if (process.env.GROK_WEB_LIVE_E2E_MUTATIONS === "1") {
      const stateResponse = await page.request.get(`/api/agent/${encodeURIComponent(sessionId)}`);
      expect(stateResponse.ok(), await stateResponse.text()).toBeTruthy();
      const stateBody = await stateResponse.json() as { state?: { modes?: { current?: string | null; available?: Array<{ id: string }> } } };
      const modes = stateBody.state?.modes;
      if (modes?.available?.length) {
        const modeId = modes.current ?? modes.available[0].id;
        const modeResponse = await page.request.post(`/api/agent/${encodeURIComponent(sessionId)}`, { data: { type: "set_standard_mode", modeId } });
        expect(modeResponse.ok(), await modeResponse.text()).toBeTruthy();
      }
      if (profileBody?.capabilities.globalFlags?.includes("--restore-code") && profileBody.capabilities.globalFlags.includes("--worktree")) {
        const restore = await page.request.post(`/api/sessions/${encodeURIComponent(sessionId)}/restore-code`, { data: { confirm: true } });
        expect([200, 400, 403, 409, 501], await restore.text()).toContain(restore.status());
        if (restore.status() === 200) {
          const restored = await restore.json() as { newSessionId: string; worktreePath: string };
          await page.request.delete(`/api/sessions/${encodeURIComponent(restored.newSessionId)}`);
          try { removeManagedWorktree(restored.worktreePath); } catch { /* cleanup verification below catches residue */ }
        }
      }
    }

    await page.goto(`/?session=${encodeURIComponent(sessionId!)}&cwd=${encodeURIComponent(cwd)}`);
    const reloadedContext = await page.request.get(`/api/sessions/${encodeURIComponent(sessionId!)}/context`);
    expect(reloadedContext.ok(), await reloadedContext.text()).toBeTruthy();
    expect(JSON.stringify(await reloadedContext.json())).toContain("LIVE_E2E_MARKER");
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
    try {
      removeManagedWorktreesForCwd(cwd);
    } catch (error) {
      cleanupError ??= error;
    }
    if (!cleanupError) {
      const sessionDir = join(process.env.GROK_WEB_LIVE_E2E_HOME ?? "", "sessions", encodeURIComponent(realpathSync(cwd)));
      rmSync(sessionDir, { recursive: true, force: true });
      if (existsSync(sessionDir)) cleanupError = new Error(`Live E2E session files remain under ${sessionDir}`);
    }
    if (cleanupError) throw cleanupError;
  }
});
