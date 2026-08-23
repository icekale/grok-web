import assert from "node:assert/strict";
import test from "node:test";

const { clearGrokCapabilitiesCache, discoverGrokCapabilities, parseCapabilityFlags } = await import("./grok-capabilities.ts");

const outputs = {
  version: "grok 1.2.3\n",
  global: "Usage: grok [OPTIONS]\n--agent <NAME>\n--sandbox <PROFILE>\n--sandboxed\n--permission-mode <MODE>\n--allow <RULE>\n--deny <RULE>\n--disable-web-search\n--no-subagents\n--max-turns <N>\n--rules <RULES>\n--restore-code\n--worktree [<WORKTREE>]\n",
  agent: "agent\n--agent-profile <PATH>\n",
  stdio: "stdio\n--leader-socket <PATH>\n",
  inspect: JSON.stringify({ agents: [{ name: "builder", description: "Builds", source: { kind: "builtin" } }, { name: 42, description: "bad" }, { name: "missing-source", source: "bad" }] }),
};

function deps() {
  let identity = { mtimeMs: 1, size: 10 };
  const calls = [];
  const execFile = async (_binary, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: outputs.version, stderr: "" };
    if (args[0] === "inspect") return { stdout: outputs.inspect, stderr: "private /Users/person/path" };
    if (args.join(" ") === "agent --help") return { stdout: outputs.agent, stderr: "" };
    if (args.join(" ") === "agent stdio --help") return { stdout: outputs.stdio, stderr: "" };
    return { stdout: outputs.global, stderr: "" };
  };
  return { calls, execFile, stat: async () => identity, change: (next) => { identity = next; } };
}

test("parses exact option tokens without treating sandboxed as sandbox", () => {
  const flags = parseCapabilityFlags("--sandbox <PROFILE> --sandboxed --no-subagents");
  assert.equal(flags.has("--sandbox"), true);
  assert.equal(flags.has("--sandboxed"), true);
  assert.equal(flags.has("--missing"), false);
});

test("discovers global, agent, stdio, version, and validated inspect capabilities", async () => {
  clearGrokCapabilitiesCache();
  const injected = deps();
  const result = await discoverGrokCapabilities("/bin/grok", injected);
  assert.equal(result.version, "grok 1.2.3");
  assert.equal(result.globalFlags.has("--agent"), true);
  assert.equal(result.agentFlags.has("--agent-profile"), true);
  assert.equal(result.stdioFlags.has("--leader-socket"), true);
  assert.deepEqual(result.agents, [{ name: "builder", description: "Builds", source: { kind: "builtin" } }]);
  assert.doesNotMatch(result.warnings.join("\n"), /Users\/person|private/);
});

test("caches by binary stat and version identity, then refreshes all probes on change", async () => {
  clearGrokCapabilitiesCache();
  const injected = deps();
  await discoverGrokCapabilities("/bin/grok", injected);
  await discoverGrokCapabilities("/bin/grok", injected);
  assert.equal(injected.calls.length, 5);
  injected.change({ mtimeMs: 2, size: 10 });
  await discoverGrokCapabilities("/bin/grok", injected);
  assert.equal(injected.calls.length, 10);
});

test("malformed help and inspect return unavailable controls with sanitized warnings", async () => {
  clearGrokCapabilitiesCache();
  const result = await discoverGrokCapabilities("/bin/grok", {
    stat: async () => ({ mtimeMs: 3, size: 11 }),
    execFile: async () => ({ stdout: "not useful /Users/person/secret", stderr: "fatal /Users/person/private" }),
  });
  assert.equal(result.globalFlags.size, 0);
  assert.equal(result.agents.length, 0);
  assert.doesNotMatch(result.warnings.join("\n"), /Users\/person|private/);
});
