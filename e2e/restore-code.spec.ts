import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { closeOwnedSession, createOwnedSession, fixtureMethods, runnerProject, authorizeProject } from "./helpers/harness";

test.skip(process.env.GROK_WEB_E2E_ISOLATED !== "1", "run through deterministic ACP E2E runner");

test("renders the advertised standard Plan mode and sends the standard ACP command", async ({ page }) => {
  await page.goto(`/?cwd=${encodeURIComponent(runnerProject("a"))}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  const created = page.waitForResponse((response) => response.url().endsWith("/api/agent/new") && response.request().method() === "POST");
  await composer.fill("E2E_TEXT_MARKER");
  await page.getByRole("button", { name: "Send" }).click();
  const sessionId = (await (await created).json()).sessionId as string;
  try {
    await expect(page.getByText("E2E_STREAM_OK", { exact: true })).toBeVisible();
    const mode = page.getByLabel("ACP mode");
    await expect(mode).toBeVisible();
    await mode.selectOption("plan");
    await expect.poll(() => fixtureMethods().filter((method) => method === "session/set_mode").length).toBeGreaterThan(0);
  } finally {
    await closeOwnedSession(page, sessionId);
  }
});

test("restores a historical session into a fixture-owned worktree without changing the source", async ({ page }) => {
  const cwd = runnerProject("a");
  await authorizeProject(page, cwd);
  const source = readFileSync(`${cwd}/README.md`, "utf8");
  const id = process.env.GROK_WEB_E2E_RESTORE_SESSION_ID || "acp-e2e-restore-session";
  let worktreePath = "";
  try {
    const preflight = await page.request.post(`/api/sessions/${encodeURIComponent(id)}/restore-code`, { data: {} });
    expect(preflight.ok(), await preflight.text()).toBeTruthy();
    expect((await preflight.json()).status).toBe("confirmation_required");
    const restored = await page.request.post(`/api/sessions/${encodeURIComponent(id)}/restore-code`, { data: { confirm: true } });
    expect(restored.ok(), await restored.text()).toBeTruthy();
    const body = await restored.json() as { status: string; worktreePath: string; newSessionId: string };
    worktreePath = body.worktreePath;
    expect(body.status).toBe("created");
    expect(existsSync(body.worktreePath)).toBeTruthy();
    expect(realpathSync(execFileSync("git", ["-C", body.worktreePath, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim())).toBe(realpathSync(body.worktreePath));
    expect(readFileSync(`${cwd}/README.md`, "utf8")).toBe(source);
    expect(fixtureMethods()).toEqual(expect.arrayContaining(["_x.ai/git/worktree/list", "_x.ai/git/worktree/create", "_x.ai/session/fork"]));
    await page.request.delete(`/api/sessions/${encodeURIComponent(body.newSessionId)}`);
  } finally {
    if (worktreePath) {
      try { execFileSync("git", ["-C", cwd, "worktree", "remove", "--force", worktreePath], { stdio: "ignore" }); } catch { /* runner root cleanup remains fail-safe */ }
    }
  }
});
