import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./WorkspaceBrowser.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("empty file pane browses cwd files and git instead of a blank hint", () => {
  assert.match(source, /\/api\/file-index/);
  assert.match(source, /\/api\/git\/status/);
  assert.match(source, /files\.browseProject/);
  assert.match(source, /files\.gitChanges/);
  assert.match(source, /buildWorkspaceTree/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.doesNotMatch(source, /slice\(0, 80\)/);
  assert.doesNotMatch(source, /slice\(0, 40\)/);
  assert.match(shell, /<WorkspaceBrowser/);
  assert.doesNotMatch(shell, /files\.noneOpen/);
});

test("workspace browser surfaces file-index and git API errors", () => {
  assert.match(source, /indexRes\.ok/);
  assert.match(source, /gitRes\.ok/);
  assert.match(source, /role="alert"/);
});

test("workspace browser refreshes when the explorer key changes", () => {
  assert.match(source, /refreshKey/);
  assert.match(source, /\[cwd, refreshKey\]/);
  assert.match(shell, /refreshKey=\{explorerRefreshKey\}/);
});

test("closed desktop panels stay in the tree but are not tabbable", () => {
  assert.match(shell, /inert=\{!isMobile && !sidebarOpen\}/);
  assert.match(shell, /inert=\{!isMobile && !rightPanelOpen\}/);
  assert.match(shell, /aria-hidden=\{!isMobile && !sidebarOpen\}/);
  assert.match(shell, /aria-hidden=\{!isMobile && !rightPanelOpen\}/);
});
