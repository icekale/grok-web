import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { AcpConnection } from "../../../lib/acp/connection.ts";
import { JsonRpcConn } from "../../../lib/acp/jsonrpc.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { AgentRuntime, resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");

const cwd = mkdtempSync(join(tmpdir(), "grok-plugins-cwd-"));
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

function postHeaders() {
  return {
    host: "127.0.0.1:30141",
    origin: "http://127.0.0.1:30141",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

describe("/api/plugins MCP adapter", () => {
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
    return jiti.import("./route.ts");
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

  it("GET contains package source docs", async () => {
    setAgentRuntime(createRuntime());
    const res = await getPlugins();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(body.packages.some((pkg) => pkg.source === "docs"));
  });

  it("POST disable then enable toggles the docs package", async () => {
    setAgentRuntime(createRuntime());
    const disabledRes = await postPlugins({ action: "disable", source: "docs" });
    assert.equal(disabledRes.status, 200, await disabledRes.clone().text());
    const disabledBody = await disabledRes.json();
    assert.equal(disabledBody.packages.find((pkg) => pkg.source === "docs")?.disabled, true);

    const enabledRes = await postPlugins({ action: "enable", source: "docs" });
    assert.equal(enabledRes.status, 200, await enabledRes.clone().text());
    const enabledBody = await enabledRes.json();
    assert.equal(enabledBody.packages.find((pkg) => pkg.source === "docs")?.disabled, false);
  });

  it("POST remove deletes the docs package", async () => {
    setAgentRuntime(createRuntime());
    const res = await postPlugins({ action: "remove", source: "docs" });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.packages.some((pkg) => pkg.source === "docs"), false);
  });

  it("POST install adds a new package from a command source", async () => {
    setAgentRuntime(createRuntime());
    const before = await (await getPlugins()).json();
    const res = await postPlugins({ action: "install", source: "true" });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(body.packages.length > before.packages.length);
    assert.ok(body.packages.some((pkg) => pkg.source === "true"));
  });

  it("POST update returns 400 because MCP update is not supported", async () => {
    setAgentRuntime(createRuntime());
    const res = await postPlugins({ action: "update", source: "docs" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "MCP update is not supported" });
  });

  it("GET stays 200 with diagnostics when listMcp throws", async () => {
    setAgentRuntime({
      listMcp: async () => {
        throw new Error("down");
      },
    });
    const res = await getPlugins();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(Array.isArray(body.diagnostics));
  });

  it("GET disk fallback keeps enabled=false from GROK_HOME config", async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-plugins-home-"));
    writeFileSync(join(home, "config.toml"), `[mcp_servers.offbox]
enabled = false
`);
    const previousHome = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      setAgentRuntime({
        listMcp: async () => {
          throw new Error("down");
        },
      });
      const res = await getPlugins();
      assert.equal(res.status, 200, await res.clone().text());
      const body = await res.json();
      const offbox = body.packages.find((pkg) => pkg.source === "offbox");
      assert.ok(offbox);
      assert.equal(offbox.disabled, true);
    } finally {
      if (previousHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previousHome;
    }
  });
});
