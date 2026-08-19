import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, describe, it, test } from "node:test";
import { createJiti } from "jiti";
import { AcpConnection } from "../../../lib/acp/connection.ts";
import { JsonRpcConn } from "../../../lib/acp/jsonrpc.ts";

const home = mkdtempSync(join(tmpdir(), "grok-skills-home-"));
const cwd = mkdtempSync(join(tmpdir(), "grok-skills-cwd-"));
const previousHome = process.env.GROK_HOME;
process.env.GROK_HOME = home;
after(() => {
  if (previousHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousHome;
});

mkdirSync(join(home, "skills", "demo"), { recursive: true });
writeFileSync(join(home, "skills", "demo", "SKILL.md"), "# demo skill\n");

const acpJiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { AgentRuntime, resetAgentRuntime, setAgentRuntime } = await acpJiti.import("@/lib/acp/runtime.ts");

test("GET /api/skills returns GROK_HOME skills without throwing", async () => {
  globalThis.__piAdditionalAllowedRoots ??= new Set();
  globalThis.__piAdditionalAllowedRoots.add(cwd);
  globalThis.__piAllowedRootsCache = undefined;
  setAgentRuntime({ listSkills: async () => { throw new Error("offline"); } });
  try {
    const { GET } = await acpJiti.import("./route.ts");
    const res = await GET(new Request(`http://127.0.0.1/api/skills?cwd=${encodeURIComponent(cwd)}`));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(Array.isArray(body.skills));
    assert.ok(body.skills.some((skill) => skill.name === "demo" && String(skill.filePath).includes("demo")));
  } finally {
    resetAgentRuntime();
  }
});

globalThis.__piAdditionalAllowedRoots ??= new Set();
globalThis.__piAdditionalAllowedRoots.add(cwd);
globalThis.__piAllowedRootsCache = undefined;

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../lib/acp/fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

describe("/api/skills ACP adapter", () => {
  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];

  afterEach(() => {
    resetAgentRuntime();
    for (const child of children.splice(0)) child.kill();
  });

  function createRuntime() {
    return new AgentRuntime({
      connect: async () => {
        const { child, acp } = spawnFake();
        children.push(child);
        return acp;
      },
    });
  }

  async function loadRoute() {
    return acpJiti.import("./route.ts");
  }

  async function getSkills() {
    const { GET } = await loadRoute();
    return GET(new Request(`http://127.0.0.1:30141/api/skills?cwd=${encodeURIComponent(cwd)}`));
  }

  it("maps disableModelInvocation from ACP enabled", async () => {
    setAgentRuntime(createRuntime());
    const res = await getSkills();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    const demo = body.skills.find((skill) => skill.name === "demo");
    assert.ok(demo);
    assert.equal(demo.disableModelInvocation, false);
    assert.equal(demo.filePath, "/tmp/demo/SKILL.md");
    assert.equal(demo.sourceInfo.scope, "user");
  });

  it("PATCH disableModelInvocation true toggles the skill off over ACP", async () => {
    const toggles = [];
    setAgentRuntime({
      listSkills: async () => ({
        skills: [
          {
            name: "demo",
            description: "demo skill",
            path: "/tmp/demo/SKILL.md",
            scope: "user",
            enabled: true,
            disable_model_invocation: false,
          },
        ],
      }),
      toggleSkill: async (name, enabled) => {
        toggles.push({ name, enabled });
        return { skills: [{ name, enabled, path: "/tmp/demo/SKILL.md" }] };
      },
    });
    const { PATCH } = await loadRoute();
    const res = await PATCH(new Request("http://127.0.0.1:30141/api/skills", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filePath: "/tmp/demo/SKILL.md",
        disableModelInvocation: true,
      }),
    }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(toggles, [{ name: "demo", enabled: false }]);
  });

  it("GET maps disableModelInvocation true after toggle", async () => {
    setAgentRuntime(createRuntime());
    const { PATCH } = await loadRoute();
    const listed = await (await getSkills()).json();
    const demo = listed.skills.find((skill) => skill.name === "demo");
    assert.equal(demo.disableModelInvocation, false);
    const patched = await PATCH(new Request("http://127.0.0.1:30141/api/skills", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filePath: demo.filePath,
        disableModelInvocation: true,
      }),
    }));
    assert.equal(patched.status, 200, await patched.clone().text());
    const after = await (await getSkills()).json();
    assert.equal(after.skills.find((skill) => skill.name === "demo")?.disableModelInvocation, true);
  });
});
