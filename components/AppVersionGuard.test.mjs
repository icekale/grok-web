import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppVersionGuard.tsx", import.meta.url), "utf8");

test("checks the server build without reloading automatically", () => {
  assert.match(source, /fetch\("\/api\/meta"/);
  assert.match(source, /cache:\s*"no-store"/);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.doesNotMatch(source, /window\.location\.reload\(\)[\s\S]*setInterval/);
});

test("checks on an interval and when the page becomes visible", () => {
  assert.match(source, /setInterval\(\(\) => \{ void check\(\); \}, UPDATE_CHECK_INTERVAL_MS\)/);
  assert.match(source, /UPDATE_CHECK_INTERVAL_MS = 60_000/);
  assert.match(source, /document\.addEventListener\("visibilitychange"/);
  assert.match(source, /document\.visibilityState === "visible"/);
});

test("renders an accessible refresh action for a newer build", () => {
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /appUpdate\.newVersion/);
  assert.match(source, /appUpdate\.reload/);
});
