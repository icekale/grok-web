import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./provider-credential-store.ts", import.meta.url), "utf8");

test("credential updates use the shared atomic writer inside the lock", () => {
  assert.match(source, /writePrivateFileAtomicSync\(authPath,/);
  assert.doesNotMatch(source, /writeFileSync\(authPath,/);
});
