import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./skills-service.ts", import.meta.url), "utf8");

test("skill listing uses ACP then GROK_HOME, not the empty foundation loader", () => {
  assert.match(source, /listSkills/);
  assert.match(source, /listGrokSkills/);
  assert.match(source, /annotateSkillsWithInstallInfo/);
  assert.doesNotMatch(source, /DefaultResourceLoader/);
});

test("project skills stay hidden until the project is trusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-skills-trust-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const skillDir = join(cwd, ".agents", "skills", "demo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Demo\n");
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { setAgentRuntime, resetAgentRuntime } = await jiti.import("./acp/runtime.ts");
  const { loadSkillsWithInstallInfo } = await jiti.import("./skills-service.ts");
  const { trustProject } = await jiti.import("./project-trust.ts");
  setAgentRuntime({ listSkills: async () => { throw new Error("offline"); } });

  try {
    const before = await loadSkillsWithInstallInfo(cwd);
    assert.equal(before.projectResourcesLoaded, false);
    assert.equal(before.skills.some((skill) => skill.name === "demo"), false);

    trustProject(cwd, home);
    const after = await loadSkillsWithInstallInfo(cwd);
    assert.equal(after.projectResourcesLoaded, true);
    assert.equal(after.skills.some((skill) => skill.name === "demo"), true);
  } finally {
    resetAgentRuntime();
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
  }
});
