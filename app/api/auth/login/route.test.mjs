import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { AcpConnection } from "../../../../lib/acp/connection.ts";
import { JsonRpcConn } from "../../../../lib/acp/jsonrpc.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { AgentRuntime, resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");

function spawnFake() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../../lib/acp/fake-agent.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rpc = new JsonRpcConn({ stdin: child.stdin, stdout: child.stdout });
  return { child, acp: new AcpConnection(rpc) };
}

describe("auth HTTP routes", () => {
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

  it("GET /api/auth/providers lists grok.com from runtime.authCheck", async () => {
    const runtime = createRuntime();
    setAgentRuntime(runtime);
    await runtime.authenticate("xai.api_key");
    const { GET } = await jiti.import("../providers/route.ts");
    const res = await GET();
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0].id, "grok.com");
    assert.equal(body.providers[0].name, "Grok");
    assert.equal(body.providers[0].usesCallbackServer, false);
    assert.equal(body.providers[0].loggedIn, true);
    assert.equal(body.providers[0].supportsApiKey, true);
  });

  it("GET /api/auth/all-providers contains only xai.api_key", async () => {
    const runtime = createRuntime();
    setAgentRuntime(runtime);
    const { GET } = await jiti.import("../all-providers/route.ts");
    const res = await GET();
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.providers.map((provider) => provider.id), ["xai.api_key"]);
    assert.equal(body.providers[0].displayName, "xAI API Key");
    assert.equal(body.providers[0].modelCount, 0);
    assert.equal(body.providers[0].supportsOAuth, true);
  });

  it("POST /api/auth/logout calls through", async () => {
    const runtime = createRuntime();
    setAgentRuntime(runtime);
    await runtime.authenticate("xai.api_key");
    const { POST } = await jiti.import("../logout/[provider]/route.ts");
    const res = await POST(new Request("http://127.0.0.1/api/auth/logout/grok.com", { method: "POST" }), {
      params: Promise.resolve({ provider: "grok.com" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await runtime.authCheck()).authenticated, false);
  });

  it("GET /api/auth/login for unknown provider emits SSE error", async () => {
    const runtime = createRuntime();
    setAgentRuntime(runtime);
    const { GET } = await jiti.import("./[provider]/route.ts");
    const res = await GET(new Request("http://127.0.0.1/api/auth/login/github"), {
      params: Promise.resolve({ provider: "github" }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const events = text.split("\n\n").flatMap((chunk) => {
      const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
      return line ? [JSON.parse(line.slice("data: ".length))] : [];
    });
    assert.ok(events.some((event) => event.type === "error"));
  });
});
