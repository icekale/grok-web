import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { resolveWorkspaceFilePath } = await createJiti(import.meta.url).import("./file-paths.ts");

test("file-paths does not import Node path into the browser", async () => {
  const source = await readFile(new URL("./file-paths.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']path["']/);
  assert.doesNotMatch(source, /from ["']node:path["']/);
  assert.doesNotMatch(source, /from ["']\.\/paths["']/);
});

test("workspace paths resolve relative entries without rewriting absolute paths", () => {
  assert.equal(resolveWorkspaceFilePath("/repo", "src/main.ts"), "/repo/src/main.ts");
  assert.equal(resolveWorkspaceFilePath("/repo", "/other/file.ts"), "/other/file.ts");
  assert.equal(resolveWorkspaceFilePath("C:\\repo", "src\\main.ts"), "C:/repo/src/main.ts");
  assert.equal(resolveWorkspaceFilePath("C:\\repo", "D:\\other\\file.ts"), "D:/other/file.ts");
  assert.equal(
    resolveWorkspaceFilePath("\\\\server\\share\\repo", "\\\\other\\share\\file.ts"),
    "//other/share/file.ts",
  );
});
