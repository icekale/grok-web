import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getGrokSettings, putGrokSettings } from "./http.ts";

describe("grok settings http", () => {
  it("GET/PUT persist settings against GROK_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-settings-http-"));
    const get = getGrokSettings(home);
    const initial = await get.json();
    assert.equal(initial.username, "grok");
    assert.equal(initial.auth.loggedIn, false);
    const put = await putGrokSettings(new Request("http://127.0.0.1/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    }), home);
    assert.equal(put.status, 200);
    const saved = getGrokSettings(home);
    const body = await saved.json();
    assert.equal(body.username, "grok");
    assert.equal(body.web.theme, "dark");
  });
});
