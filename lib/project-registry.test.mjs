import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { normalizeProjectPreferences } = await import("./project-registry-core.ts");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getProjectRegistryPath, readProjectPreferences, updateProjectPreference } = await jiti.import("./project-registry.ts");

test("canonical project registry is grok-web-projects.json and copies leftover pi-web-projects.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-project-registry-"));
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = directory;
  const firstPath = resolve(directory, "project-a");
  await writeFile(join(directory, "pi-web-projects.json"), JSON.stringify({
    version: 1,
    projects: [{ path: firstPath, pinned: true, archived: false, removed: false, order: 0 }],
  }));

  try {
    const path = getProjectRegistryPath();
    assert.equal(path, join(directory, "grok-web-projects.json"));
    const projects = readProjectPreferences();
    assert.equal(projects[0]?.path, firstPath);
    assert.equal(projects[0]?.pinned, true);
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes project metadata without changing project paths", () => {
  const projectPath = resolve("project-a");
  assert.deepEqual(normalizeProjectPreferences([{
    path: projectPath,
    name: "  Project A  ",
    pinned: true,
    archived: false,
    removed: false,
    order: 4,
  }]), [{
    path: projectPath,
    name: "Project A",
    pinned: true,
    archived: false,
    removed: false,
    order: 4,
  }]);
});

test("rejects duplicate and relative project paths", () => {
  const projectPath = resolve("project-a");
  assert.throws(() => normalizeProjectPreferences([{ path: "relative", order: 0 }]));
  assert.throws(() => normalizeProjectPreferences([
    { path: projectPath, order: 0 },
    { path: projectPath, order: 1 },
  ]));
});

test("updates one project without overwriting concurrent project metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-project-registry-"));
  const registryPath = join(directory, "projects.json");
  const firstPath = resolve(directory, "project-a");
  const secondPath = resolve(directory, "project-b");
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [
      { path: firstPath, pinned: false, archived: true, removed: false, order: 0 },
      { path: secondPath, name: "Current name", pinned: true, archived: true, removed: false, order: 1 },
    ],
  }));

  try {
    await Promise.all([
      updateProjectPreference(firstPath, { archived: false }, registryPath),
      updateProjectPreference(secondPath, { archived: false }, registryPath),
    ]);
    const stored = JSON.parse(await readFile(registryPath, "utf8"));
    assert.deepEqual(stored.projects, [
      { path: firstPath, pinned: false, archived: false, removed: false, order: 0 },
      { path: secondPath, name: "Current name", pinned: true, archived: false, removed: false, order: 1 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
