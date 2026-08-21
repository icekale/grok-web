import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, test } from "node:test";
import { createJiti } from "jiti";
import { AcpConnection } from "./acp/connection.ts";
import { JsonRpcConn } from "./acp/jsonrpc.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { AgentRuntime, resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");

const cwd = mkdtempSync(join(tmpdir(), "grok-mcp-cwd-"));
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

test("TanStack /api/mcp serves MCP handlers and /api/plugins serves grok plugins", async () => {
  const mcp = await readFile(new URL("../src/routes/api/mcp.ts", import.meta.url), "utf8");
  const plugins = await readFile(new URL("../src/routes/api/plugins.ts", import.meta.url), "utf8");
  assert.match(mcp, /from ["']@\/lib\/mcp-http["']/);
  assert.match(plugins, /from ["']@\/lib\/plugins-http["']/);
});

describe("/api/mcp adapter", () => {
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
    return jiti.import("./mcp-http.ts");
  }

  async function getMcp() {
    const { GET } = await loadRoute();
    return GET(new Request(`http://127.0.0.1:30141/api/mcp?cwd=${encodeURIComponent(cwd)}`));
  }

  async function postMcp(body) {
    const { POST } = await loadRoute();
    return POST(new Request("http://127.0.0.1:30141/api/mcp", {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({ cwd, ...body }),
    }));
  }

  it("GET contains package source docs", async () => {
    setAgentRuntime(createRuntime());
    const res = await getMcp();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(body.packages.some((pkg) => pkg.source === "docs"));
  });

  it("POST disable then enable toggles the docs package", async () => {
    setAgentRuntime(createRuntime());
    const disabledRes = await postMcp({ action: "disable", source: "docs" });
    assert.equal(disabledRes.status, 200, await disabledRes.clone().text());
    const disabledBody = await disabledRes.json();
    assert.equal(disabledBody.packages.find((pkg) => pkg.source === "docs")?.disabled, true);

    const enabledRes = await postMcp({ action: "enable", source: "docs" });
    assert.equal(enabledRes.status, 200, await enabledRes.clone().text());
    const enabledBody = await enabledRes.json();
    assert.equal(enabledBody.packages.find((pkg) => pkg.source === "docs")?.disabled, false);
  });

  it("POST remove deletes the docs package", async () => {
    setAgentRuntime(createRuntime());
    const res = await postMcp({ action: "remove", source: "docs" });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.packages.some((pkg) => pkg.source === "docs"), false);
  });

  it("POST add upserts a stdio MCP server", async () => {
    setAgentRuntime(createRuntime());
    const res = await postMcp({ action: "add", source: "probe", command: "true" });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(body.packages.some((pkg) => pkg.source === "probe"));
  });

  it("GET includes MCP servers bundled by enabled plugins", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-plugin-mcp-"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: {
        ast_grep: { command: "node", args: ["${GROK_PLUGIN_ROOT}/cli.js"] },
      },
    }));
    setAgentRuntime({
      listMcp: async () => ({ servers: [] }),
      listPlugins: async () => ({
        plugins: [{ name: "oh-my-grok", enabled: true, root, mcpServerCount: 1 }],
      }),
    });
    const res = await getMcp();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    const ast = body.packages.find((pkg) => pkg.source === "ast_grep");
    assert.ok(ast);
    assert.equal(ast.origin, "plugin");
    assert.equal(ast.pluginName, "oh-my-grok");
    assert.equal(ast.disabled, false);
  });

  it("GET omits MCP servers bundled by disabled plugins", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-plugin-mcp-off-"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { ast_grep: { command: "node" } },
    }));
    setAgentRuntime({
      listMcp: async () => ({ servers: [] }),
      listPlugins: async () => ({
        plugins: [{ name: "oh-my-grok", enabled: false, root, mcpServerCount: 1 }],
      }),
    });
    const res = await getMcp();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.packages.some((pkg) => pkg.source === "ast_grep"), false);
  });

  it("GET keeps plugin origin when ACP already lists the plugin MCP server", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-plugin-mcp-acp-"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { ast_grep: { command: "node" } },
    }));
    setAgentRuntime({
      listMcp: async () => ({
        servers: [{ name: "ast_grep", command: "node", session: { enabled: true } }],
      }),
      listPlugins: async () => ({
        plugins: [{ name: "oh-my-grok", enabled: true, root }],
      }),
    });
    const res = await getMcp();
    assert.equal(res.status, 200, await res.clone().text());
    const ast = (await res.json()).packages.find((pkg) => pkg.source === "ast_grep");
    assert.equal(ast.origin, "plugin");
    assert.equal(ast.pluginName, "oh-my-grok");
  });

  it("POST remove rejects plugin-bundled MCP servers", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-plugin-mcp-rm-"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { ast_grep: { command: "node" } },
    }));
    setAgentRuntime({
      listMcp: async () => ({ servers: [] }),
      listPlugins: async () => ({
        plugins: [{ name: "oh-my-grok", enabled: true, root }],
      }),
      deleteMcp: async () => {
        throw new Error("should not delete plugin MCP");
      },
    });
    const res = await postMcp({ action: "remove", source: "ast_grep" });
    assert.equal(res.status, 400);
  });

  it("POST install and scope are rejected", async () => {
    setAgentRuntime(createRuntime());
    const install = await postMcp({ action: "install", source: "true" });
    assert.equal(install.status, 400);
    const scoped = await postMcp({ action: "enable", source: "docs", scope: "global" });
    assert.equal(scoped.status, 400);
  });

  it("POST update returns 400 because MCP update is not supported", async () => {
    setAgentRuntime(createRuntime());
    const res = await postMcp({ action: "update", source: "docs" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "MCP update is not supported" });
  });

  it("GET stays 200 with diagnostics when listMcp throws", async () => {
    setAgentRuntime({
      listMcp: async () => {
        throw new Error("down");
      },
    });
    const res = await getMcp();
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.ok(Array.isArray(body.diagnostics));
  });

  it("GET disk fallback keeps enabled=false from GROK_HOME config", async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-mcp-home-"));
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
      const res = await getMcp();
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
