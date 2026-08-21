import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const handlerSource = await readFile(new URL("./session-http.ts", import.meta.url), "utf8");
const adapterSource = await readFile(new URL("../src/routes/api/sessions.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

test("sessions handler uses only standard Web response APIs", () => {
  assert.doesNotMatch(handlerSource, /next\/server|NextResponse/);
  assert.match(adapterSource, /getSessions\(request\)/);
  assert.match(handlerSource, /Response\.json/);
});

test("TanStack sessions route delegates to the existing handler", () => {
  assert.match(adapterSource, /GET: \(\{ request \}\) => getSessions\(request\)/);
});

test("sessions handler preserves JSON shape and cache headers", async () => {
  const { getSessions } = await jiti.import("./session-http.ts");
  const response = await getSessions(new Request("http://localhost/api/sessions?force=1"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(Array.isArray(body.sessions));
  assert.ok(Array.isArray(body.runningSessionIds));
});
