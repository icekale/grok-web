import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shows Stage Discard Commit only when the file has a git diff", async () => {
  const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  const toolbar = source.slice(
    source.indexOf("{hasGitDiff && cwd && ("),
    source.indexOf("{displayModes.length > 1 && ("),
  );
  assert.match(toolbar, /files\.stage/);
  assert.match(toolbar, /files\.discard/);
  assert.match(toolbar, /files\.commit/);
  assert.match(toolbar, /file-viewer-mode-button/);
});
