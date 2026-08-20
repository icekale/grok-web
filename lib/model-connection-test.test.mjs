import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const {
  buildModelTestRequest,
  extractModelTestText,
  testModelConnection,
} = await jiti.import("./model-connection-test.ts");
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("builds OpenAI chat completions and responses endpoints", () => {
  const chat = buildModelTestRequest({
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    modelId: "gpt-test",
    apiKey: "sk-test",
    headers: {},
  });
  assert.equal(chat.url, "https://api.example.com/v1/chat/completions");
  assert.match(chat.body, /"messages"/);

  const responses = buildModelTestRequest({
    api: "openai-responses",
    baseUrl: "https://api.example.com/v1",
    modelId: "gpt-test",
    apiKey: "sk-test",
    headers: {},
  });
  assert.equal(responses.url, "https://api.example.com/v1/responses");
  assert.match(responses.body, /"input"/);
});

test("extracts assistant text from provider payloads", () => {
  assert.equal(extractModelTestText("openai-completions", {
    choices: [{ message: { content: "OK" } }],
  }), "OK");
  assert.equal(extractModelTestText("openai-responses", {
    output_text: "OK from responses",
  }), "OK from responses");
  assert.equal(extractModelTestText("anthropic-messages", {
    content: [{ type: "text", text: "OK claude" }],
  }), "OK claude");
  assert.equal(extractModelTestText("google-generative-ai", {
    candidates: [{ content: { parts: [{ text: "OK gemini" }] } }],
  }), "OK gemini");
});

test("testModelConnection posts and returns latency without ModelRuntime", async () => {
  const calls = [];
  const result = await testModelConnection({
    providerName: "cpa",
    provider: {
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
    },
    model: { id: "grok-4.6" },
    lookup: publicLookup,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: init.body });
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.responseText, "OK");
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
});

test("testModelConnection reports missing API keys", async () => {
  const result = await testModelConnection({
    providerName: "missing",
    provider: { api: "openai-completions", baseUrl: "https://api.example.com/v1" },
    model: { id: "x" },
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /No API key found/);
});

test("testModelConnection rejects DNS answers that resolve to link-local", async () => {
  let fetches = 0;
  const result = await testModelConnection({
    providerName: "cpa",
    provider: {
      api: "openai-completions",
      baseUrl: "https://provider.example/v1",
      apiKey: "sk-test",
    },
    model: { id: "grok-4.6" },
    lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ choices: [] }));
    },
  });
  assert.equal(result.ok, false);
  assert.equal(fetches, 0);
  assert.match(result.error ?? "", /link-local|special-use/i);
});

test("testModelConnection uses stored headers even when the request sends none", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-model-test-headers-"));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: { cpa: {
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      apiKey: "sk-stored-key",
      headers: { "X-Stored": "yes" },
    } },
  }));
  try {
    const calls = [];
    const result = await testModelConnection({
      providerName: "cpa",
      provider: { api: "openai-completions", baseUrl: "https://api.example.com/v1", headers: {} },
      model: { id: "grok-4.6" },
      lookup: publicLookup,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init.headers) });
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].headers.get("X-Stored"), "yes");
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("testModelConnection does not reuse stored auth for a different effective model API", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-model-test-api-binding-"));
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: {
      cpa: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        apiKey: "sk-stored-key",
        models: [{ id: "grok-4.6", api: "anthropic-messages" }],
      },
    },
  }));
  try {
    let fetches = 0;
    const result = await testModelConnection({
      providerName: "cpa",
      provider: { api: "openai-completions", baseUrl: "https://api.example.com/v1" },
      model: { id: "grok-4.6", api: "google-generative-ai" },
      lookup: publicLookup,
      fetchImpl: async () => {
        fetches += 1;
        return new Response("{}");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /No API key found/i);
    assert.equal(fetches, 0);
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("testModelConnection resolves an echoed stored model-level environment header", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-model-test-model-env-"));
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  process.env.GROK_WEB_MODEL_HEADER = "resolved-model-secret";
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: {
      cpa: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        apiKey: "sk-stored-key",
        models: [{ id: "grok-4.6", headers: { "X-Model-Secret": "$GROK_WEB_MODEL_HEADER" } }],
      },
    },
  }));
  try {
    const result = await testModelConnection({
      providerName: "cpa",
      provider: { api: "openai-completions", baseUrl: "https://api.example.com/v1" },
      model: { id: "grok-4.6", headers: { "X-Model-Secret": "$GROK_WEB_MODEL_HEADER" } },
      lookup: publicLookup,
      fetchImpl: async (_url, init) => {
        assert.equal(new Headers(init.headers).get("X-Model-Secret"), "resolved-model-secret");
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(result.ok, true);
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    delete process.env.GROK_WEB_MODEL_HEADER;
    rmSync(home, { recursive: true, force: true });
  }
});

test("testModelConnection allows header-only stored auth", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-model-test-header-only-"));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: { cpa: {
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      headers: { Authorization: "Bearer stored-token" },
    } },
  }));
  try {
    const result = await testModelConnection({
      providerName: "cpa",
      provider: { api: "openai-completions", baseUrl: "https://api.example.com/v1", headers: {} },
      model: { id: "grok-4.6" },
      lookup: publicLookup,
      fetchImpl: async (_url, init) => {
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer stored-token");
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(result.ok, true);
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
