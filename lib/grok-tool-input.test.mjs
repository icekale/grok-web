import assert from "node:assert/strict";
import test from "node:test";
import { grokCanonicalToolName, grokToolPreviewValue, sanitizeGrokToolInput } from "./grok-tool-input.ts";

test("drops Grok schema padding from tool input", () => {
  assert.deepEqual(
    sanitizeGrokToolInput({
      variant: "Grep",
      pattern: "marketplace",
      path: null,
      glob: "*.ts",
      "-i": false,
      type: null,
      head_limit: 80,
      multiline: false,
    }),
    { pattern: "marketplace", glob: "*.ts", head_limit: 80 },
  );
  assert.deepEqual(
    sanitizeGrokToolInput({
      variant: "Bash",
      command: "ls",
      description: "list",
      is_background: false,
    }),
    { command: "ls", description: "list" },
  );
});

test("preview prefers a real path or pattern over a null path", () => {
  assert.equal(
    grokToolPreviewValue({ path: null, pattern: "foo" }, ["command", "path", "file_path", "target_file", "pattern"]),
    "foo",
  );
  assert.equal(
    grokToolPreviewValue({ target_file: "/tmp/a.ts", variant: "ReadFile" }, ["target_file", "path"]),
    "/tmp/a.ts",
  );
});

test("canonicalizes Grok terminal tools to bash", () => {
  assert.equal(grokCanonicalToolName("run_terminal_command"), "bash");
  assert.equal(grokCanonicalToolName("Execute `ls -la`", "execute"), "bash");
  assert.equal(grokCanonicalToolName("", "execute"), "bash");
  assert.equal(grokCanonicalToolName("read_file"), "read_file");
  assert.equal(grokCanonicalToolName("grep", "search"), "grep");
});
