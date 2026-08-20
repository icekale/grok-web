import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "grok-models-config-route-"));
const previousHome = process.env.GROK_HOME;
process.env.GROK_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousHome;
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET, PUT } = await jiti.import("./route.ts");

describe("/api/models-config", () => {
  it("rejects a non-object PUT body", async () => {
    const res = await PUT(new Request("http://127.0.0.1/api/models-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    }));
    assert.equal(res.status, 400);
  });

  it("returns a diagnosable error for a corrupt file instead of empty providers", async () => {
    writeFileSync(join(home, "models.json"), "[1]");
    const res = await GET();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(String(body.error), /object|JSON/i);
  });
});
