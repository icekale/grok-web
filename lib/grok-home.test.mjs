import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { grokHome, grokWebMetaDir, grokSessionsDir } from "./grok-home.ts";

test("pi-stubs directory is gone", () => {
  assert.equal(existsSync(join(process.cwd(), "lib/pi-stubs")), false);
});

describe("grok-home", () => {
  it("defaults to ~/.grok", () => {
    const prev = process.env.GROK_HOME;
    delete process.env.GROK_HOME;
    try {
      assert.equal(grokHome(), join(homedir(), ".grok"));
      assert.equal(grokSessionsDir(), join(homedir(), ".grok", "sessions"));
      assert.equal(grokWebMetaDir(), join(homedir(), ".grok", "grok-web"));
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("honors GROK_HOME and trims it", () => {
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = " /tmp/grok-home-test ";
    try {
      assert.equal(grokHome(), "/tmp/grok-home-test");
      assert.equal(grokSessionsDir(), "/tmp/grok-home-test/sessions");
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
