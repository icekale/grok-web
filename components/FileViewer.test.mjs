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
  assert.match(toolbar, /setDiscardOpen\(true\)/);
  assert.match(toolbar, /files\.commit/);
  assert.match(toolbar, /file-viewer-git-actions/);
  assert.match(toolbar, /file-viewer-git-button/);
  assert.doesNotMatch(toolbar, /file-viewer-mode-switch/);
});

test("commit dialog names the Git index", async () => {
  const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /files\.commitTitle/);
  assert.match(source, /files\.commitCopy/);
  assert.match(source, /files\.commit/);
});

test("discard asks for confirmation before writing git", async () => {
  const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /files\.confirmDiscard/);
  assert.match(source, /gitDiff\?\.status === "untracked"/);
  assert.match(source, /files\.confirmDeleteUntrackedCopy/);
  assert.match(source, /files\.deleteUntrackedFile/);
  assert.match(source, /setDiscardOpen\(true\)/);
  assert.match(source, /runGitWrite\("discard"\)/);
  assert.doesNotMatch(source, /runGitWrite\("discard"\)\.then\(\(\) => setDiscardOpen\(false\)\)/);
  assert.match(source, /action === "discard"/);
});

test("HTML files stay on source until preview is chosen", async () => {
  const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /data\?\.language === "markdown"/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf("defaultPreviewEligibleRef.current"),
      source.indexOf("}, [data?.language, updateDisplayMode]"),
    ),
    /language === "html"/,
  );
  assert.match(source, /sandbox=""/);
  assert.doesNotMatch(source, /allow-scripts/);
});

test("markdown preview opens external links in a new tab", async () => {
  const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /target: "_blank"/);
  assert.match(source, /rel: "noopener noreferrer"/);
  assert.match(source, /\/\^https\?:\\\/\\\//);
});
