import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "reject-root-publish.mjs");

test("refuses npm publish from the repository root", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pack:tanstack/);
});

test("allows an explicit override for staged publication", () => {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, GROK_WEB_ALLOW_ROOT_PUBLISH: "1" },
  });
  assert.equal(result.status, 0);
});
