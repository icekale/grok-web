import assert from "node:assert/strict";
import test from "node:test";
import { parseGrokInspect } from "./grok-inspect.ts";

test("parseGrokInspect reads hooks, projectTrusted, and projectRoot", () => {
  const parsed = parseGrokInspect({
    projectTrusted: true,
    projectRoot: "/repo",
    hooks: [{
      event: "(plugin)",
      hookType: "file",
      target: "/plugins/oh-my-grok/hooks/hooks.json",
      matcher: null,
      source: { type: "plugin", plugin_name: "oh-my-grok", path: "/plugins/oh-my-grok" },
    }],
  });
  assert.equal(parsed.projectTrusted, true);
  assert.equal(parsed.projectRoot, "/repo");
  assert.equal(parsed.hooks[0].sourceType, "plugin");
  assert.equal(parsed.hooks[0].pluginName, "oh-my-grok");
  assert.equal(parsed.hooks[0].removable, false);
});

test("parseGrokInspect keeps inspect folderTrustEnabled when present", () => {
  assert.equal(parseGrokInspect({ folderTrustEnabled: false }).folderTrustEnabled, false);
  assert.equal(parseGrokInspect({}).folderTrustEnabled, undefined);
});

test("parseGrokInspect ignores malformed hook rows", () => {
  const parsed = parseGrokInspect({ hooks: [{ event: 1 }, null, "x"] });
  assert.deepEqual(parsed.hooks, []);
  assert.equal(parsed.projectTrusted, false);
});

test("parseGrokInspect marks user hook files removable", () => {
  const parsed = parseGrokInspect({
    hooks: [{
      event: "SessionStart",
      hookType: "file",
      target: "/tmp/grok-home/hooks/web.json",
      source: { type: "global" },
    }],
  }, "/tmp/grok-home");
  assert.equal(parsed.hooks[0].removable, true);
});

test("runGrokInspect parses injected inspect stdout", async () => {
  const { runGrokInspect } = await import("./grok-inspect.ts");
  const snapshot = await runGrokInspect("/repo", {
    resolveBin: () => "/bin/grok",
    execFile: async () => ({ stdout: JSON.stringify({ projectTrusted: false, hooks: [] }) }),
  });
  assert.equal(snapshot.projectTrusted, false);
  assert.deepEqual(snapshot.hooks, []);
});
