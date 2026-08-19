import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("API key saves do not use ModelRuntime.login's network refresh", async () => {
  const source = await readFile(new URL("../app/api/auth/api-key/[provider]/route.ts", import.meta.url), "utf-8");

  assert.doesNotMatch(source, /ModelRuntime/);
  assert.doesNotMatch(source, /modelRuntime\.login\(/);
  assert.doesNotMatch(source, /apiKeyAuth\.login\(/);
  assert.doesNotMatch(source, /storeProviderCredential/);
  assert.match(source, /writeGrokApiKey/);
  assert.match(source, /\.authenticate\(/);
  assert.match(source, /clearGrokApiKey/);
  assert.match(source, /\.authLogout\(/);
});
