import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { AcpConnection } from "../../../../lib/acp/connection.ts";
import { JsonRpcConn } from "../../../../lib/acp/jsonrpc.ts";
import { hasGrokApiKey, readGrokAuth } from "../../../../lib/grok-settings/home-config.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { AgentRuntime, resetAgentRuntime, setAgentRuntime } = await jiti.import("@/lib/acp/runtime.ts");

function parseSse(text) {
  return text.split("\n\n").flatMap((chunk) => {
    const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
    return line ? [JSON.parse(line.slice("data: ".length))] : [];
  });
}

function withCancelSpy(inner) {
  let cancels = 0;
  const runtime = new Proxy(inner, {
    get(t, p, r) {
      if (p === "authCancel") return async (...args) => { cancels++; return t.authCancel(...args); };
      return Reflect.get(t, p, r);
    },
  });
  return {
    runtime,
    getCancels: () => cancels,
  };
}

async function readSseEvents(body, onEvent, timeoutMs = 4000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("login SSE timed out")), remaining);
        }),
      ]);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice("data: ".length));
        events.push(event);
        if (onEvent && await onEvent(event, events)) return events;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

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
  const originalGrokHome = process.env.GROK_HOME;

  afterEach(() => {
    resetAgentRuntime();
    for (const child of children.splice(0)) child.kill();
    if (originalGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
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

  it("GET /api/auth/providers is logged in when a model table api_key exists even if authCheck is false", async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-login-model-key-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    writeFileSync(join(home, "config.toml"), `[model."grok-4.6"]\napi_key = "model-secret"\n`);
    setAgentRuntime({
      authCheck: async () => ({ authenticated: false }),
    });
    try {
      const { GET } = await jiti.import("../providers/route.ts");
      const res = await GET();
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.providers[0].loggedIn, true);
      const { GET: getKeys } = await jiti.import("../all-providers/route.ts");
      const keys = await (await getKeys()).json();
      assert.equal(keys.providers[0].configured, true);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

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
    const home = mkdtempSync(join(tmpdir(), "grok-logout-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const runtime = createRuntime();
      setAgentRuntime(runtime);
      await runtime.authenticate("xai.api_key");
      const { POST } = await jiti.import("../logout/[provider]/route.ts");
      const res = await POST(new Request("http://127.0.0.1/api/auth/logout/grok.com", { method: "POST" }), {
        params: Promise.resolve({ provider: "grok.com" }),
      });
      assert.equal(res.status, 200);
      assert.equal((await runtime.authCheck()).authenticated, false);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("POST /api/auth/logout disconnects a model-table api_key account", async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-logout-model-key-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    writeFileSync(join(home, "config.toml"), `[model."grok-4.6"]\napi_key = "model-secret"\n`);
    try {
      const runtime = createRuntime();
      setAgentRuntime(runtime);
      const { POST } = await jiti.import("../logout/[provider]/route.ts");
      const res = await POST(new Request("http://127.0.0.1/api/auth/logout/grok.com", { method: "POST" }), {
        params: Promise.resolve({ provider: "grok.com" }),
      });
      assert.equal(res.status, 200);
      assert.equal(hasGrokApiKey(home), false);
      const { GET: getProviders } = await jiti.import("../providers/route.ts");
      const providers = await (await getProviders()).json();
      assert.equal(providers.providers[0].loggedIn, false);
      const { GET: getKeys } = await jiti.import("../all-providers/route.ts");
      const keys = await (await getKeys()).json();
      assert.equal(keys.providers[0].configured, false);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("POST /api/auth/logout still clears OAuth tokens if ACP logout fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-logout-acp-fail-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    writeFileSync(join(home, "config.toml"), `[model."grok-4.6"]\napi_key = "model-secret"\n`);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ "grok.com": { token: "oauth" } }));
    try {
      setAgentRuntime({
        authLogout: async () => {
          throw new Error("agent offline");
        },
      });
      const { POST } = await jiti.import("../logout/[provider]/route.ts");
      const res = await POST(new Request("http://127.0.0.1/api/auth/logout/grok.com", { method: "POST" }), {
        params: Promise.resolve({ provider: "grok.com" }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
      assert.equal(hasGrokApiKey(home), false);
      assert.equal(readGrokAuth(home).loggedIn, false);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
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

  it("GET /api/auth/login for grok.com emits success without device flow when already authenticated", async () => {
    const spy = withCancelSpy(createRuntime());
    const runtime = spy.runtime;
    setAgentRuntime(runtime);
    await runtime.authenticate("xai.api_key");
    const { GET } = await jiti.import("./[provider]/route.ts");
    const abort = new AbortController();
    const res = await GET(new Request("http://127.0.0.1/api/auth/login/grok.com", { signal: abort.signal }), {
      params: Promise.resolve({ provider: "grok.com" }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const events = parseSse(text);
    assert.ok(events.some((event) => event.type === "success"));
    assert.equal(events.some((event) => event.type === "auth" || event.type === "device_code"), false);
    assert.equal(spy.getCancels(), 0);
    assert.equal((await runtime.authCheck()).authenticated, true);
  });

  it("GET /api/auth/login for grok.com emits auth and device_code then succeeds after submit_code", async () => {
    const spy = withCancelSpy(createRuntime());
    const runtime = spy.runtime;
    setAgentRuntime(runtime);
    const { GET, POST } = await jiti.import("./[provider]/route.ts");
    const abort = new AbortController();
    const res = await GET(new Request("http://127.0.0.1/api/auth/login/grok.com", { signal: abort.signal }), {
      params: Promise.resolve({ provider: "grok.com" }),
    });
    assert.equal(res.status, 200);
    const events = await readSseEvents(res.body, async (event) => {
      if (event.type === "auth") {
        await runtime.authSubmitCode("FAKE-CODE");
        const submitted = await POST(new Request("http://127.0.0.1/api/auth/login/grok.com", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: event.token, code: "FAKE-CODE" }),
        }), { params: Promise.resolve({ provider: "grok.com" }) });
        assert.equal(submitted.status, 200);
      }
      return event.type === "success";
    });
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(events.some((event) => event.type === "auth" && typeof event.url === "string" && event.url.startsWith("https://")));
    assert.ok(events.some((event) => event.type === "device_code" && event.userCode));
    assert.ok(events.some((event) => event.type === "success") || (await runtime.authCheck()).authenticated === true);
    assert.equal(spy.getCancels(), 0);
    assert.equal((await runtime.authCheck()).authenticated, true);
  });

  it("calls authCancel when login SSE is aborted before success", async () => {
    const spy = withCancelSpy(createRuntime());
    const runtime = spy.runtime;
    setAgentRuntime(runtime);
    const { GET } = await jiti.import("./[provider]/route.ts");
    const abort = new AbortController();
    const res = await GET(new Request("http://127.0.0.1/api/auth/login/grok.com", { signal: abort.signal }), {
      params: Promise.resolve({ provider: "grok.com" }),
    });
    const reader = res.body.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    const start = Date.now();
    while (spy.getCancels() === 0 && Date.now() - start < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(spy.getCancels(), 1);
  });

  it("POST/GET/DELETE /api/auth/api-key/xai.api_key persist without exposing the key", async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-apikey-http-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    try {
      const runtime = createRuntime();
      setAgentRuntime(runtime);
      const { GET, POST, DELETE } = await jiti.import("../api-key/[provider]/route.ts");
      const params = { params: Promise.resolve({ provider: "xai.api_key" }) };
      const saved = await POST(new Request("http://127.0.0.1/api/auth/api-key/xai.api_key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "test-key" }),
      }), params);
      assert.equal(saved.status, 200);
      const listed = await GET(new Request("http://127.0.0.1/api/auth/api-key/xai.api_key"), params);
      const raw = await listed.text();
      assert.equal(listed.status, 200);
      assert.doesNotMatch(raw, /test-key/);
      const body = JSON.parse(raw);
      assert.equal(body.configured, true);
      assert.equal(hasGrokApiKey(home), true);
      const deleted = await DELETE(new Request("http://127.0.0.1/api/auth/api-key/xai.api_key", { method: "DELETE" }), params);
      assert.equal(deleted.status, 200);
      assert.equal(hasGrokApiKey(home), false);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });

  it("DELETE /api/auth/api-key disconnects a model-table api_key", async () => {
    const home = mkdtempSync(join(tmpdir(), "grok-apikey-model-http-"));
    const prev = process.env.GROK_HOME;
    process.env.GROK_HOME = home;
    writeFileSync(join(home, "config.toml"), `[model."grok-4.6"]\napi_key = "model-secret"\n`);
    try {
      const runtime = createRuntime();
      setAgentRuntime(runtime);
      const { DELETE } = await jiti.import("../api-key/[provider]/route.ts");
      const deleted = await DELETE(new Request("http://127.0.0.1/api/auth/api-key/xai.api_key", { method: "DELETE" }), {
        params: Promise.resolve({ provider: "xai.api_key" }),
      });
      assert.equal(deleted.status, 200);
      assert.equal(hasGrokApiKey(home), false);
    } finally {
      if (prev === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev;
    }
  });
});
