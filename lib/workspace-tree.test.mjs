import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceTree } from "./workspace-tree.ts";

test("buildWorkspaceTree nests folders and sorts folders before files", () => {
  const tree = buildWorkspaceTree([
    "README.md",
    "src/app.ts",
    "src/lib/tree.ts",
    "src/lib/tree.test.ts",
  ]);
  assert.equal(tree[0].name, "src");
  assert.ok(tree[0].children);
  assert.equal(tree[0].children[0].name, "lib");
  assert.deepEqual(tree[0].children[0].children?.map((node) => node.name), ["tree.test.ts", "tree.ts"]);
  assert.equal(tree[0].children[1].name, "app.ts");
  assert.equal(tree[1].name, "README.md");
  assert.equal(tree[1].children, undefined);
});
