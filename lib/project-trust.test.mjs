import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "grok-project-trust-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  return { root, cwd, agentDir };
}

async function loadSubject() {
  const jiti = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    moduleCache: false,
  });
  return jiti.import("./project-trust.ts");
}

test("projects without protected resources are trusted without a stored approval", async () => {
  const { getProjectTrustStatus } = await loadSubject();
  const { cwd, agentDir, root } = fixture();

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: false,
    trusted: true,
  });
  assert.deepEqual(getProjectTrustStatus(join(root, "missing"), agentDir), {
    requiresTrust: false,
    trusted: true,
  });
});

test("non-empty project skill and extension directories require trust", async () => {
  const { getProjectTrustStatus } = await loadSubject();

  for (const resourceDir of [[".agents", "skills"], [".pi", "extensions"]]) {
    const { cwd, agentDir } = fixture();
    const dir = join(cwd, ...resourceDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "resource.ts"), "throw new Error('must not execute')\n");

    assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
      requiresTrust: true,
      trusted: false,
    });
  }
});

test("empty project resource directories do not require trust", async () => {
  const { getProjectTrustStatus } = await loadSubject();
  const { cwd, agentDir } = fixture();
  mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: false,
    trusted: true,
  });
});

test("settings extension entries require trust without importing their files", async () => {
  const { getProjectTrustStatus } = await loadSubject();
  const { cwd, agentDir } = fixture();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "extension.mjs"), "globalThis.__projectExtensionExecuted = true;\n");
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ extensions: ["./extension.mjs"] }),
  );
  delete globalThis.__projectExtensionExecuted;

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: true,
    trusted: false,
  });
  assert.equal(globalThis.__projectExtensionExecuted, undefined);
});

test("approval persists across fresh module instances", async () => {
  const first = await loadSubject();
  const { cwd, agentDir } = fixture();
  mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");

  assert.deepEqual(first.trustProject(cwd, agentDir), {
    requiresTrust: true,
    trusted: true,
  });

  const second = await loadSubject();
  assert.deepEqual(second.getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: true,
    trusted: true,
  });
  assert.match(
    readFileSync(join(agentDir, "grok-web", "project-trust.json"), "utf8"),
    /"trustedProjects"/,
  );
});

test("project identity is canonicalized through symlinks", async () => {
  const { getProjectTrustStatus, trustProject } = await loadSubject();
  const { root, cwd, agentDir } = fixture();
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "extensions", "demo.ts"), "export default () => {};\n");
  const linkedCwd = join(root, "linked-project");
  symlinkSync(cwd, linkedCwd, "dir");

  assert.equal(getProjectTrustStatus(linkedCwd, agentDir).trusted, false);
  trustProject(linkedCwd, agentDir);

  assert.equal(getProjectTrustStatus(cwd, agentDir).trusted, true);
  assert.equal(getProjectTrustStatus(linkedCwd, agentDir).trusted, true);
});

test("corrupt trust store is diagnosable, untrusted, and not overwritten", async () => {
  const { getProjectTrustStatus, trustProject } = await loadSubject();
  const { cwd, agentDir } = fixture();
  mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");
  const storePath = join(agentDir, "grok-web", "project-trust.json");
  mkdirSync(join(agentDir, "grok-web"), { recursive: true });
  writeFileSync(storePath, "{broken", "utf8");

  const status = getProjectTrustStatus(cwd, agentDir);
  assert.equal(status.requiresTrust, true);
  assert.equal(status.trusted, false);
  assert.match(status.error, /project trust store/i);
  assert.throws(() => trustProject(cwd, agentDir), /project trust store/i);
  assert.equal(readFileSync(storePath, "utf8"), "{broken");
});

test("unreadable trust store is diagnosable and remains restricted", async () => {
  const { getProjectTrustStatus, trustProject } = await loadSubject();
  const { cwd, agentDir } = fixture();
  mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");
  const storePath = join(agentDir, "grok-web", "project-trust.json");
  mkdirSync(storePath, { recursive: true });

  const status = getProjectTrustStatus(cwd, agentDir);
  assert.equal(status.trusted, false);
  assert.match(status.error, /read project trust store/i);
  assert.throws(() => trustProject(cwd, agentDir), /read project trust store/i);
  assert.equal(statSync(storePath).isDirectory(), true);
});

test("trust store is written with private file permissions", async () => {
  const { trustProject } = await loadSubject();
  const { cwd, agentDir } = fixture();
  mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");

  trustProject(cwd, agentDir);

  const mode = statSync(join(agentDir, "grok-web", "project-trust.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("concurrent trust writers retain every approval", { timeout: 30_000 }, async () => {
  const { root, agentDir } = fixture();
  const barrier = join(root, "barrier");
  mkdirSync(barrier);
  const projects = Array.from({ length: 12 }, (_, index) => {
    const cwd = join(root, `project-${index}`);
    mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");
    return cwd;
  });
  const childSource = `
    import { existsSync, writeFileSync } from "node:fs";
    import { basename, join } from "node:path";
    import { createJiti } from "jiti";
    const [cwd, agentDir, barrier] = process.argv.slice(1);
    const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
    const { trustProject } = await jiti.import("@/lib/project-trust.ts");
    writeFileSync(join(barrier, basename(cwd) + ".ready"), "");
    while (!existsSync(join(barrier, "start"))) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    trustProject(cwd, agentDir);
  `;
  const writers = projects.map((cwd) => execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", childSource, cwd, agentDir, barrier],
    { cwd: process.cwd() },
  ));

  const deadline = Date.now() + 15_000;
  while (
    readdirSync(barrier).filter((name) => name.endsWith(".ready")).length < projects.length
    && Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    readdirSync(barrier).filter((name) => name.endsWith(".ready")).length,
    projects.length,
  );
  writeFileSync(join(barrier, "start"), "");
  await Promise.all(writers);

  const stored = JSON.parse(readFileSync(join(agentDir, "grok-web", "project-trust.json"), "utf8"));
  assert.deepEqual(
    stored.trustedProjects.map((path) => basename(path)).sort(),
    projects.map((path) => basename(path)).sort(),
  );
});

test("reload options resolve the current persisted approval", async () => {
  const { projectTrustReloadOptions, trustProject } = await loadSubject();
  const { cwd, agentDir } = fixture();
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "extensions", "demo.ts"), "export default () => {};\n");

  const before = projectTrustReloadOptions(cwd, agentDir);
  assert.ok(before);
  assert.equal(await before.resolveProjectTrust(), false);
  trustProject(cwd, agentDir);
  assert.equal(await before.resolveProjectTrust(), true);
});

test("reload resolver rescans when protected resources appear", async () => {
  const { projectTrustReloadOptions, trustProject } = await loadSubject();
  const { cwd, agentDir } = fixture();

  const options = projectTrustReloadOptions(cwd, agentDir);
  assert.ok(options);
  assert.equal(await options.resolveProjectTrust(), true);

  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "extensions", "demo.ts"), "export default () => {};\n");
  assert.equal(await options.resolveProjectTrust(), false);

  trustProject(cwd, agentDir);
  assert.equal(await options.resolveProjectTrust(), true);
});
