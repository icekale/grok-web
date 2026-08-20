import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("keeps restricted trust status and exposes store diagnostics in the trust dialog", () => {
  const loader = source.match(
    /fetch\(`\/api\/project-trust\?cwd=[\s\S]*?\n  \}, \[projectTrustCwd\]\);/,
  )?.[0];
  assert.ok(loader);
  assert.doesNotMatch(loader, /if \(!response\.ok \|\| data\.error\) throw/);
  assert.match(
    loader,
    /setProjectTrust\(data\);\s*setProjectTrustError\(data\.error \?\? null\)/,
  );
  assert.match(source, /setProjectTrustError\(projectTrust\.error \?\? null\)/);
  assert.match(source, /<ProjectTrustDialog[\s\S]*?error=\{projectTrustError\}/);
});
