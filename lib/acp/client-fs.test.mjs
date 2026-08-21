import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readAcpTextFile, writeAcpTextFile } from "./client-fs.ts";

function jail() {
  const root = mkdtempSync(join(tmpdir(), "acp-fs-"));
  return { root, roots: new Set([root]) };
}

describe("ACP client filesystem", () => {
  it("reads the full file or a 1-based line window", () => {
    const { root, roots } = jail();
    const path = join(root, "lines.txt");
    writeFileSync(path, "one\ntwo\nthree\n");
    assert.equal(readAcpTextFile({ path }, roots).content, "one\ntwo\nthree\n");
    assert.equal(readAcpTextFile({ path, line: 2, limit: 1 }, roots).content, "two");
  });

  it("creates parent directories when writing inside the jail", () => {
    const { root, roots } = jail();
    const path = join(root, "nested", "out.txt");
    assert.equal(writeAcpTextFile({ path, content: "saved" }, roots), null);
    assert.equal(readAcpTextFile({ path }, roots).content, "saved");
  });

  it("rejects a missing path or non-string write content", () => {
    const { roots } = jail();
    assert.throws(() => readAcpTextFile({}, roots), /path is required/);
    assert.throws(() => writeAcpTextFile({ content: "x" }, roots), /path is required/);
    assert.throws(
      () => writeAcpTextFile({ path: join(tmpdir(), "x"), content: 1 }, roots),
      /content is required/,
    );
  });

  it("rejects paths and symlink escapes outside the jail", () => {
    const { root, roots } = jail();
    const outside = join(mkdtempSync(join(tmpdir(), "acp-fs-out-")), "secret.txt");
    writeFileSync(outside, "secret");
    assert.throws(() => readAcpTextFile({ path: outside }, roots), /Access denied/);
    assert.throws(
      () => writeAcpTextFile({ path: outside, content: "nope" }, roots),
      /Access denied/,
    );
    const link = join(root, "escape");
    symlinkSync(outside, link);
    assert.throws(() => readAcpTextFile({ path: link }, roots), /Access denied/);
    assert.throws(
      () => writeAcpTextFile({ path: link, content: "wiped" }, roots),
      /Access denied/,
    );
    assert.equal(readFileSync(outside, "utf8"), "secret");
  });

  it("rejects relative paths without a session cwd", () => {
    const { roots } = jail();
    assert.throws(() => readAcpTextFile({ path: "rel.txt" }, roots), /Access denied/);
  });

  it("resolves relative paths against the session cwd", () => {
    const { root, roots } = jail();
    writeFileSync(join(root, "rel.txt"), "inside");
    assert.equal(readAcpTextFile({ path: "rel.txt" }, roots, root).content, "inside");
  });

  it("can read an extra root that writes still cannot touch", () => {
    const { root, roots } = jail();
    const extra = mkdtempSync(join(tmpdir(), "acp-fs-extra-"));
    const extraFile = join(extra, "skill.md");
    writeFileSync(extraFile, "skill");
    const readRoots = new Set([...roots, extra]);
    assert.equal(readAcpTextFile({ path: extraFile }, readRoots).content, "skill");
    assert.throws(
      () => writeAcpTextFile({ path: extraFile, content: "nope" }, roots),
      /Access denied/,
    );
    assert.equal(readFileSync(extraFile, "utf8"), "skill");
  });
});
