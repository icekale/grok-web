import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("offline page", () => {
  it("tells the user Grok Web is offline, not Pi Web", async () => {
    const html = await readFile(new URL("./offline.html", import.meta.url), "utf8");
    assert.match(html, /Grok Web is offline/);
    assert.match(html, /local Grok Web server/);
    assert.doesNotMatch(html, /Pi Web/);
  });
});
