import { expect, test } from "@playwright/test";

test.skip(process.env.GROK_WEB_E2E_ISOLATED !== "1", "run through deterministic ACP E2E runner");
test("runtime profile exposes capabilities and applies an idle profile transaction", async ({ page }) => {
  await page.goto(`/?cwd=${encodeURIComponent(process.env.GROK_WEB_E2E_PROJECT_A || process.cwd())}`);
  const get = await page.request.get("/api/runtime-profile");
  expect(get.ok()).toBeTruthy();
  const body = await get.json();
  expect(body.profile.version).toBe(1);
  expect(body.capabilities.globalFlags).toContain("--permission-mode");
  const next = { ...body.profile, permissionMode: "plan" };
  const applied = await page.request.put("/api/runtime-profile", { data: next });
  expect(applied.ok(), await applied.text()).toBeTruthy();
  expect((await applied.json()).profile.permissionMode).toBe("plan");
  const restored = await page.request.put("/api/runtime-profile", { data: body.profile });
  expect(restored.ok(), await restored.text()).toBeTruthy();
});
