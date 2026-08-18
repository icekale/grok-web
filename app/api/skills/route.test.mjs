import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "grok-skills-home-"));
const cwd = mkdtempSync(join(tmpdir(), "grok-skills-cwd-"));
const previousHome = process.env.GROK_HOME;
process.env.GROK_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousHome;
});

mkdirSync(join(home, "skills", "demo"), { recursive: true });
writeFileSync(join(home, "skills", "demo", "SKILL.md"), "# demo skill\n");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  moduleCache: false,
});

test("GET /api/skills returns GROK_HOME skills without throwing", async () => {
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(cwd);
  globalThis.__piAllowedRootsCache = undefined;
  const { GET } = await jiti.import("./route.ts");
  const res = await GET(new Request(`http://127.0.0.1/api/skills?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.ok(Array.isArray(body.skills));
  assert.ok(body.skills.some((skill) => skill.name === "demo" && String(skill.filePath).includes("demo")));
});
