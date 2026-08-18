import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const start = await readFile(new URL("../src/start.ts", import.meta.url), "utf8");

test("the shared Start entry does not pull undici into the browser", () => {
  assert.doesNotMatch(start, /http-dispatcher/);
  assert.doesNotMatch(start, /undici/);
});
