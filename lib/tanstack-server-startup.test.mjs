import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const startupGuard = await readFile(new URL("../src/plugins/server-startup-guard.ts", import.meta.url), "utf8");

test("configures the HTTP dispatcher before exposing the Start fetch handler", () => {
  const firstImport = source.match(/^import\s+["']([^"']+)["']/m)?.[1];
  assert.equal(firstImport, "@/lib/http-dispatcher-init");
  const configureCall = source.indexOf("configureHttpDispatcher();");
  const bindGuard = startupGuard.indexOf("assertServerBindAllowed");
  const entryCreation = source.indexOf("createServerEntry({");
  const handlerCall = source.indexOf("handler.fetch(request)");
  assert.ok(configureCall >= 0);
  assert.ok(bindGuard >= 0);
  assert.match(startupGuard, /isWebPasswordEnabled/);
  assert.doesNotMatch(startupGuard, /process\.env\.GROK_WEB_PASSWORD\s*\|\|/);
  assert.ok(entryCreation > configureCall);
  assert.ok(handlerCall > configureCall);
  assert.doesNotMatch(source, /fetch\(request\)[\s\S]*configureHttpDispatcher/);
});
