import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("API key saves do not use ModelRuntime.login's network refresh", async () => {
  const source = await readFile(new URL("./auth-api-key-http.ts", import.meta.url), "utf-8");

  assert.doesNotMatch(source, /ModelRuntime/);
  assert.doesNotMatch(source, /modelRuntime\.login\(/);
  assert.doesNotMatch(source, /apiKeyAuth\.login\(/);
  assert.doesNotMatch(source, /storeProviderCredential/);
  assert.match(source, /writeGrokApiKey/);
  assert.match(source, /\.authenticate\(/);
  assert.match(source, /clearGrokApiKey/);
  assert.match(source, /\.authLogout\(/);
});

test("account logout clears stored grok api keys before ACP logout", async () => {
  const source = await readFile(new URL("./auth-logout-http.ts", import.meta.url), "utf-8");
  assert.match(source, /clearGrokApiKey/);
  const clearAt = source.indexOf("clearGrokApiKey()");
  const logoutAt = source.indexOf(".authLogout(");
  assert.ok(clearAt !== -1 && logoutAt !== -1 && clearAt < logoutAt);
});
