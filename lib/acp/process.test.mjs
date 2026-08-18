import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveGrokBin, grokAgentArgs } from "./process.ts";

describe("resolveGrokBin", () => {
  it("prefers GROK_BIN when the file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-bin-"));
    const bin = join(dir, "grok");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    const prev = process.env.GROK_BIN;
    process.env.GROK_BIN = bin;
    try {
      assert.equal(resolveGrokBin(), bin);
    } finally {
      if (prev === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prev;
    }
  });

  it("falls back to GROK_HOME/bin/grok", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-home-"));
    await mkdir(join(home, "bin"), { recursive: true });
    const bin = join(home, "bin", "grok");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    const prevHome = process.env.GROK_HOME;
    const prevBin = process.env.GROK_BIN;
    delete process.env.GROK_BIN;
    process.env.GROK_HOME = home;
    try {
      assert.equal(resolveGrokBin(), bin);
    } finally {
      if (prevHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevHome;
      if (prevBin === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prevBin;
    }
  });

  it("throws grok-missing when neither exists", () => {
    const prevHome = process.env.GROK_HOME;
    const prevBin = process.env.GROK_BIN;
    process.env.GROK_HOME = "/tmp/grok-home-does-not-exist";
    process.env.GROK_BIN = "/tmp/grok-bin-does-not-exist";
    try {
      assert.throws(() => resolveGrokBin(), /grok-missing|not found/i);
    } finally {
      if (prevHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prevHome;
      if (prevBin === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = prevBin;
    }
  });
});

describe("grokAgentArgs", () => {
  it("starts stdio without always-approve", () => {
    assert.deepEqual(grokAgentArgs(), ["agent", "stdio"]);
    assert.ok(!grokAgentArgs().includes("--always-approve"));
    assert.ok(!grokAgentArgs().includes("--yolo"));
  });
});
