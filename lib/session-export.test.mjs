import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { packSessionArchive, renderSessionHtml } from "./session-export.ts";

describe("renderSessionHtml", () => {
  it("includes the title and user text", () => {
    const html = renderSessionHtml("Demo title", [
      { role: "user", content: "Hello <world>" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }], model: "grok", provider: "grok" },
    ]);
    assert.match(html, /Demo title/);
    assert.match(html, /Hello &lt;world&gt;/);
    assert.match(html, /Hi/);
    assert.match(html, /<!doctype html>/i);
  });
});

describe("packSessionArchive", () => {
  it("zips the session directory including summary.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-export-"));
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: "s1" } }));
    writeFileSync(join(dir, "updates.jsonl"), "{}\n");
    mkdirSync(join(dir, "subagents"), { recursive: true });
    writeFileSync(join(dir, "subagents", "note.txt"), "child");
    const archive = packSessionArchive(dir, "s1");
    assert.equal(archive.fileName, "grok-session-s1.zip");
    assert.ok(archive.bytes.length > 0);
    const out = mkdtempSync(join(tmpdir(), "grok-export-out-"));
    const zipPath = join(out, "s.zip");
    writeFileSync(zipPath, archive.bytes);
    execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
    const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
    assert.match(listing, /summary\.json/);
    assert.match(listing, /updates\.jsonl/);
  });
});
