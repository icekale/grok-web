import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addUserHook, removeUserHook, renderUserHookFile } from "./user-hooks.ts";

test("renderUserHookFile rejects unknown events and non-loopback http", () => {
  assert.throws(() => renderUserHookFile({ event: "Nope", type: "command", command: "true" }), /Unsupported/);
  assert.throws(() => renderUserHookFile({ event: "Stop", type: "http", url: "http://example.com/h" }), /https or loopback/);
  const text = renderUserHookFile({ event: "Stop", type: "http", url: "https://hooks.example/h", timeout: 15 });
  assert.match(text, /"timeout": 15/);
});

test("renderUserHookFile writes Grok JSON for a command hook", () => {
  const text = renderUserHookFile({
    event: "SessionStart",
    type: "command",
    command: "echo hi",
  });
  assert.match(text, /"SessionStart"/);
  assert.match(text, /"command": "echo hi"/);
  assert.doesNotMatch(text, /timeout/);
});

test("addUserHook writes under GROK_HOME/hooks and removeUserHook deletes only that file", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-hooks-home-"));
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    const added = addUserHook({ event: "PreToolUse", type: "command", command: "true", matcher: "Bash" });
    assert.equal(added.startsWith(join(home, "hooks") + "/"), true);
    const body = JSON.parse(readFileSync(added, "utf8"));
    assert.equal(body.hooks.PreToolUse[0].matcher, "Bash");
    removeUserHook(added);
    assert.throws(() => readFileSync(added));
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
});

test("removeUserHook refuses paths outside GROK_HOME/hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-hooks-home-"));
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    const plugin = join(home, "installed-plugins", "x", "hooks.json");
    mkdirSync(join(home, "installed-plugins", "x"), { recursive: true });
    writeFileSync(plugin, "{}");
    assert.throws(() => removeUserHook(plugin), /refused|outside/i);
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
});
