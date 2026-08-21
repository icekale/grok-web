import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { AcpConnection } from "./acp/connection.ts";
import { JsonRpcConn } from "./acp/jsonrpc.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { AgentRuntime, resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");

const cwd = mkdtempSync(join(tmpdir(), "grok-plugins-cwd-"));
globalThis.__piAdditionalAllowedRoots ??= new Set();
globalThis.__piAdditionalAllowedRoots.add(cwd);
globalThis.__piAllowedRootsCache = undefined;

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./acp/fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

function postHeaders() {
  return {
    host: "127.0.0.1:30141",
    origin: "http://127.0.0.1:30141",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

describe("/api/plugins grok plugins", () => {
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
    return jiti.import("./plugins-http.ts");
  }

  async function getPlugins() {
    const { GET } = await loadRoute();
    return GET(new Request(`http://127.0.0.1:30141/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  }

  async function postPlugins(body) {
    const { POST } = await loadRoute();
    return POST(new Request("http://127.0.0.1:30141/api/plugins", {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({ cwd, ...body }),
    }));
  }

  it("GET lists grok plugins and marketplace sources", async () => {
    setAgentRuntime(createRuntime());
    const res = await getPlugins();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    const demo = body.packages.find((pkg) => pkg.source === "demo-plugin");
    assert.ok(demo);
    assert.equal(demo.disabled, false);
    assert.equal(demo.counts.skills, 1);
    assert.ok(demo.resources.some((resource) => resource.name === "demo-skill"));
    assert.ok(Array.isArray(body.marketplace.sources));
  });

  it("POST disable then enable toggles a grok plugin", async () => {
    setAgentRuntime(createRuntime());
    const disabledRes = await postPlugins({ action: "disable", source: "demo-plugin" });
    assert.equal(disabledRes.status, 200, await disabledRes.clone().text());
    const disabledBody = await disabledRes.json();
    assert.equal(disabledBody.packages.find((pkg) => pkg.source === "demo-plugin")?.disabled, true);

    const enabledRes = await postPlugins({ action: "enable", source: "demo-plugin" });
    assert.equal(enabledRes.status, 200, await enabledRes.clone().text());
    const enabledBody = await enabledRes.json();
    assert.equal(enabledBody.packages.find((pkg) => pkg.source === "demo-plugin")?.disabled, false);
  });

  it("POST remove uninstalls a grok plugin", async () => {
    setAgentRuntime(createRuntime());
    const res = await postPlugins({ action: "remove", source: "demo-plugin" });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.packages.some((pkg) => pkg.source === "demo-plugin"), false);
  });

  it("POST install adds a plugin from a source", async () => {
    setAgentRuntime(createRuntime());
    const res = await postPlugins({ action: "install", source: "/tmp/extra-plugin" });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(body.packages.some((pkg) => pkg.source === "extra-plugin"));
  });

  it("POST add_source then marketplace_install installs from a catalog", async () => {
    setAgentRuntime(createRuntime());
    const added = await postPlugins({ action: "add_source", url: "https://example.com/probe.git" });
    assert.equal(added.status, 200, await added.clone().text());
    const addedBody = await added.json();
    assert.equal(addedBody.marketplace.sources[0]?.sourceUrlOrPath, "https://example.com/probe.git");

    const installed = await postPlugins({
      action: "marketplace_install",
      source_url_or_path: "https://example.com/probe.git",
      plugin_relative_path: "plugins/hello",
    });
    assert.equal(installed.status, 200, await installed.clone().text());
    const body = await installed.json();
    assert.ok(body.packages.some((pkg) => pkg.source === "hello"));
  });

  it("GET reloads when marketplace shows an installed plugin missing from the list", async () => {
    let reloaded = false;
    const plugin = {
      name: "superpowers",
      enabled: true,
      version: "6.3.0",
      skillCount: 14,
      skillNames: ["brainstorming"],
    };
    setAgentRuntime({
      listPlugins: async () => ({ plugins: reloaded ? [plugin] : [] }),
      listMarketplace: async () => ({
        sources: [{
          sourceName: "plugin-marketplace",
          sourceUrlOrPath: "https://github.com/xai-org/plugin-marketplace.git",
          plugins: [{ name: "superpowers", relativePath: "superpowers", installStatus: "installed" }],
        }],
      }),
      pluginsAction: async (_cwd, action) => {
        if (action.type === "reload") reloaded = true;
        return { status: "success", message: "Reloaded plugins." };
      },
    });
    const res = await getPlugins();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(reloaded, true);
    assert.equal(body.packages.find((pkg) => pkg.source === "superpowers")?.version, "6.3.0");
  });

  it("GET stays 200 with diagnostics when listPlugins throws", async () => {
    setAgentRuntime({
      listPlugins: async () => {
        throw new Error("down");
      },
      listMarketplace: async () => ({ sources: [] }),
    });
    const res = await getPlugins();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(Array.isArray(body.diagnostics));
    assert.equal(body.packages.length, 0);
  });
});
