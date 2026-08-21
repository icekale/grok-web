import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const libDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(libDir, "..");

const DELETE_ME = new Set([
  "lib/rpc-manager.ts",
  "lib/rpc-manager.test.mjs",
  "lib/rpc-manager-shutdown.test.mjs",
  "lib/rpc-manager-widgets.test.mjs",
  "lib/rpc-session-info.test.mjs",
]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".output") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
    const rel = relative(repoRoot, path);
    if (DELETE_ME.has(rel)) continue;
    files.push(path);
  }
  return files;
}

test("runtime paths do not import rpc-manager", () => {
  const source = [
    readFileSync(new URL("./acp/runtime.ts", import.meta.url), "utf8"),
    readFileSync(new URL("./acp/http.ts", import.meta.url), "utf8"),
  ].join("\n");
  assert.doesNotMatch(source, /rpc-manager/);
});

test("lib/ src/ hooks/ components/ have no startRpcSession and no rpc-manager import", () => {
  const hits = [];
  for (const dir of ["lib", "src", "hooks", "components"]) {
    for (const file of walk(join(repoRoot, dir))) {
      const source = readFileSync(file, "utf8");
      const rel = relative(repoRoot, file);
      if (/\bstartRpcSession\b/.test(source)) hits.push(`${rel}: startRpcSession`);
      if (/(?:from|import)\s+["'][^"']*rpc-manager/.test(source) || /rpc-manager/.test(source)) {
        hits.push(`${rel}: rpc-manager`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("lib/rpc-manager.ts does not exist", () => {
  assert.equal(existsSync(join(libDir, "rpc-manager.ts")), false);
});
