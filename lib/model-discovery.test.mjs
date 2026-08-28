import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import(path);
  } catch {
    return import(path);
  }
}

const {
  buildModelsListUrl,
  parseDiscoveredModels,
  normalizeProviderBaseUrl,
  assertSafeDiscoveryTarget,
  safeDiscoveryFetch,
} = await loadSubject("./model-discovery.ts");
const { resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");

test("normalizes host-only base URLs to /v1 for OpenAI-style APIs", () => {
  assert.equal(normalizeProviderBaseUrl("https://www.codex2api.com", "openai-responses"), "https://www.codex2api.com/v1");
  assert.equal(normalizeProviderBaseUrl("https://www.codex2api.com/", "openai-completions"), "https://www.codex2api.com/v1");
  assert.equal(normalizeProviderBaseUrl("https://api.example.com/v1", "openai-completions"), "https://api.example.com/v1");
  assert.equal(normalizeProviderBaseUrl("https://api.example.com/custom", "openai-completions"), "https://api.example.com/custom");
  assert.equal(normalizeProviderBaseUrl("https://api.anthropic.com", "anthropic-messages"), "https://api.anthropic.com");
  assert.equal(normalizeProviderBaseUrl("https://www.codex2api.com", "google-generative-ai"), "https://www.codex2api.com");
});

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("rejects non-http(s) discovery targets", () => {
  assert.throws(
    () => assertSafeDiscoveryTarget(new URL("file:///etc/passwd"), {}),
    /http/,
  );
  assert.throws(
    () => assertSafeDiscoveryTarget(new URL("ftp://api.example.com/models"), { apiKey: "k" }),
    /http/,
  );
});

test("never forwards credentials to link-local or unspecified targets", () => {
  for (const target of [
    "http://169.254.169.254/latest/meta-data",
    "http://0.0.0.0/v1/models",
  ]) {
    assert.throws(
      () => assertSafeDiscoveryTarget(new URL(target), { apiKey: "stored-key" }),
      /private|loopback|local/i,
      `${target} must be rejected with credentials`,
    );
  }
  assert.throws(
    () => assertSafeDiscoveryTarget(new URL("http://169.254.169.254/latest/meta-data"), { headers: { Authorization: "Bearer x" } }),
    /private|loopback|local/i,
    "header credentials must be blocked too",
  );
});

test("rejects link-local and unspecified targets even without credentials", () => {
  assert.throws(
    () => assertSafeDiscoveryTarget(new URL("http://169.254.169.254/latest/meta-data"), {}),
    /link-local|private|special/i,
  );
  assert.throws(
    () => assertSafeDiscoveryTarget(new URL("http://0.0.0.0/v1/models"), {}),
    /link-local|private|special/i,
  );
});

test("blocks current IANA IPv4 special-purpose /24 ranges at both boundaries", () => {
  for (const [network, last] of [
    ["192.31.196.0", "192.31.196.255"],
    ["192.52.193.0", "192.52.193.255"],
    ["192.175.48.0", "192.175.48.255"],
  ]) {
    for (const address of [network, last]) {
      assert.throws(
        () => assertSafeDiscoveryTarget(new URL(`http://${address}/models`)),
        /special-use/i,
        `${address} must be blocked`,
      );
    }
  }
  for (const address of ["192.31.195.255", "192.31.197.0", "8.8.8.8"]) {
    assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL(`http://${address}/models`)));
  }
});

test("blocks the full 2001:20::/28 special-use range at its boundaries", () => {
  for (const address of ["2001:20::", "2001:2f:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    assert.throws(
      () => assertSafeDiscoveryTarget(new URL(`http://[${address}]/models`)),
      /special-use/i,
      `${address} must be blocked`,
    );
  }
  assert.doesNotThrow(
    () => assertSafeDiscoveryTarget(new URL("http://[2001:4860::1]/models")),
    "Google's public 2001:4860:: range must remain allowed",
  );
});

test("blocks current IANA special-purpose additions at both CIDR boundaries", () => {
  for (const [network, last] of [
    ["2001:30::", "2001:3f:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["100:0:0:1::", "100:0:0:1:ffff:ffff:ffff:ffff"],
  ]) {
    for (const address of [network, last]) {
      assert.throws(
        () => assertSafeDiscoveryTarget(new URL(`http://[${address}]/models`)),
        /special-use/i,
        `${address} must be blocked`,
      );
    }
  }
});

test("covers the complete IANA protocol-assignment and AS112 ranges", () => {
  for (const address of [
    "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2620:4f:8000:ffff:ffff:ffff:ffff:ffff",
  ]) {
    assert.throws(
      () => assertSafeDiscoveryTarget(new URL(`http://[${address}]/models`)),
      /special-use/i,
      `${address} must be blocked`,
    );
  }
  assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL("http://[2001:200::1]/models")));
  assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL("http://[2001:4860::1]/models")));
});

test("blocks deprecated fec0::/10 site-local addresses at both boundaries", () => {
  for (const address of ["fec0::", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    assert.throws(
      () => assertSafeDiscoveryTarget(new URL(`http://[${address}]/models`)),
      /special-use/i,
      `${address} must be blocked`,
    );
  }
  assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL("http://[fe7f:ffff::1]/models")));
});

test("allows RFC1918 LAN targets with credentials", () => {
  for (const target of [
    "http://192.168.5.28:18085/v1/models",
    "http://10.0.0.8/v1/models",
    "http://172.16.0.1/v1/models",
  ]) {
    assert.doesNotThrow(
      () => assertSafeDiscoveryTarget(new URL(target), { apiKey: "stored-key" }),
      `${target} must be allowed with credentials`,
    );
  }
  assert.doesNotThrow(
    () => assertSafeDiscoveryTarget(new URL("http://192.168.5.28:18085/v1/models"), { headers: { Authorization: "Bearer x" } }),
  );
});

test("allows loopback targets with credentials for local proxies", () => {
  for (const target of [
    "http://127.0.0.1:8787/v1/models",
    "http://127.0.0.1:11434/v1/models",
    "http://localhost:1234/v1/models",
    "http://[::1]:8000/v1/models",
  ]) {
    assert.doesNotThrow(
      () => assertSafeDiscoveryTarget(new URL(target), { apiKey: "stored-key" }),
      `${target} must be allowed with credentials`,
    );
  }
  assert.doesNotThrow(
    () => assertSafeDiscoveryTarget(new URL("http://127.0.0.1:8787/v1/models"), { headers: { Authorization: "Bearer x" } }),
  );
});

test("applies IPv4 policy to mapped IPv6 addresses", () => {
  for (const target of [
    "http://[::ffff:127.0.0.1]:8787/models",
    "http://[::ffff:10.0.0.8]/models",
    "http://[::ffff:192.168.5.28]/models",
    "http://[::ffff:198.18.21.218]/models",
  ]) {
    assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL(target)));
  }
  assert.throws(
    () => assertSafeDiscoveryTarget(new URL("http://[::ffff:169.254.169.254]/latest/meta-data")),
    /special-use|link-local/i,
  );
});

test("allows private targets without credentials for local models", () => {
  assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL("http://127.0.0.1:11434/v1/models"), {}));
  assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL("http://localhost:1234/v1/models"), {}));
  assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL("http://127.0.0.1:11434/v1/models"), { headers: {} }));
});

test("allows public targets with credentials", () => {
  assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL("https://api.openai.com/v1/models"), { apiKey: "stored-key" }));
  assert.doesNotThrow(() => assertSafeDiscoveryTarget(new URL("https://api.example.com/v1/models"), { headers: { "X-Key": "v" } }));
});

test("allows Clash/Surge fake-ip 198.18.0.0/15 literals at both boundaries", () => {
  for (const address of ["198.18.0.0", "198.18.21.218", "198.19.255.255"]) {
    assert.doesNotThrow(
      () => assertSafeDiscoveryTarget(new URL(`http://${address}/v1/models`), { apiKey: "stored-key" }),
      `${address} must be allowed for local proxy DNS`,
    );
  }
});

test("allows a public hostname that resolves to Clash/Surge fake-ip", async () => {
  let fetches = 0;
  const response = await safeDiscoveryFetch("https://api.699968.xyz/v1/models", {}, {
    lookup: async (hostname) => {
      assert.equal(hostname, "api.699968.xyz");
      return [{ address: "198.18.21.218", family: 4 }];
    },
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}");
    },
  });
  assert.equal(response.status, 200);
  assert.equal(fetches, 1);
});

test("rejects a public hostname when any resolved address is link-local", async () => {
  let fetches = 0;
  await assert.rejects(
    safeDiscoveryFetch("https://provider.example/v1/models", {}, {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
      fetchImpl: async () => {
        fetches += 1;
        return new Response("{}");
      },
    }),
    /link-local|special-use/i,
  );
  assert.equal(fetches, 0);
});

test("undici connects through the validated pinned lookup address", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(`${req.socket.remoteAddress}|${req.headers.host}`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    let lookups = 0;
    const response = await safeDiscoveryFetch(`http://provider.invalid:${address.port}/models`, {}, {
      lookup: async (hostname) => {
        lookups += 1;
        assert.equal(hostname, "provider.invalid");
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    assert.equal(await response.text(), `127.0.0.1|provider.invalid:${address.port}`);
    assert.equal(lookups, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("revalidates redirects and rejects a forbidden redirect target", async () => {
  let fetches = 0;
  await assert.rejects(
    safeDiscoveryFetch("https://provider.example/v1/models", {}, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data" },
        });
      },
    }),
    /link-local|special-use/i,
  );
  assert.equal(fetches, 1);
});

test("strips credentials and custom headers on cross-origin redirects", async () => {
  const calls = [];
  const response = await safeDiscoveryFetch("https://one.example/v1/models", {
    headers: {
      Accept: "application/json",
      Authorization: "Bearer secret",
      "X-Provider-Key": "custom-secret",
    },
  }, {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init.headers), redirect: init.redirect, dispatcher: init.dispatcher });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { Location: "https://two.example/models" } });
      }
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(await response.text(), "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].redirect, "manual");
  assert.ok(calls[0].dispatcher);
  assert.equal(calls[1].headers.get("authorization"), null);
  assert.equal(calls[1].headers.get("x-provider-key"), null);
  assert.equal(calls[1].headers.get("accept"), "application/json");
});

test("matches Fetch redirect method, body, and content-header behavior", async () => {
  const cases = [
    { status: 301, method: "POST", nextMethod: "GET", keepsBody: false, stripsBodyHeaders: true },
    { status: 302, method: "POST", nextMethod: "GET", keepsBody: false, stripsBodyHeaders: true },
    { status: 303, method: "PUT", nextMethod: "GET", keepsBody: false, stripsBodyHeaders: true },
    { status: 303, method: "HEAD", nextMethod: "HEAD", keepsBody: false, stripsBodyHeaders: false },
    { status: 301, method: "PUT", nextMethod: "PUT", keepsBody: true, stripsBodyHeaders: false },
    { status: 302, method: "PATCH", nextMethod: "PATCH", keepsBody: true, stripsBodyHeaders: false },
    { status: 307, method: "POST", nextMethod: "POST", keepsBody: true, stripsBodyHeaders: false },
    { status: 308, method: "POST", nextMethod: "POST", keepsBody: true, stripsBodyHeaders: false },
  ];
  for (const expected of cases) {
    const calls = [];
    await safeDiscoveryFetch("https://provider.example/start", {
      method: expected.method,
      body: expected.method === "HEAD" ? undefined : "payload",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Language": "en",
        "Content-Location": "/payload",
        "X-Keep": "yes",
      },
    }, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (_input, init) => {
        calls.push(init);
        return calls.length === 1
          ? new Response(null, { status: expected.status, headers: { Location: "/next" } })
          : new Response("ok");
      },
    });
    assert.equal(calls[1].method, expected.nextMethod, `${expected.status} ${expected.method}`);
    assert.equal(calls[1].body !== undefined, expected.keepsBody, `${expected.status} ${expected.method} body`);
    const headers = new Headers(calls[1].headers);
    assert.equal(headers.get("x-keep"), "yes");
    for (const name of ["content-type", "content-encoding", "content-language", "content-location"]) {
      assert.equal(headers.has(name), !expected.stripsBodyHeaders, `${expected.status} ${expected.method} ${name}`);
    }
  }
});

test("aborts delayed DNS lookup before fetch", async () => {
  let fetches = 0;
  await assert.rejects(
    safeDiscoveryFetch("https://provider.example/models", {
      signal: AbortSignal.timeout(5),
    }, {
      lookup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return [{ address: "93.184.216.34", family: 4 }];
      },
      fetchImpl: async () => {
        fetches += 1;
        return new Response("ok");
      },
    }),
    (error) => error?.name === "TimeoutError",
  );
  assert.equal(fetches, 0);
});

test("closes each dispatcher on final, fetch-error, body-error, and redirect-error paths", async () => {
  for (const kind of ["final", "fetch-error", "body-error", "redirect-error"]) {
    let closes = 0;
    const dispatcher = { close: async () => { closes += 1; } };
    const promise = safeDiscoveryFetch("https://provider.example/models", {}, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      createDispatcher: () => dispatcher,
      fetchImpl: async () => {
        if (kind === "fetch-error") throw new Error("fetch failed");
        if (kind === "body-error") {
          return {
            status: 200,
            statusText: "OK",
            headers: new Headers(),
            body: {},
            arrayBuffer: async () => { throw new Error("body failed"); },
          };
        }
        if (kind === "redirect-error") return new Response(null, { status: 302 });
        return new Response("ok");
      },
    });
    if (kind === "final") await promise;
    else await assert.rejects(promise);
    assert.equal(closes, 1, kind);
  }
});

test("rejects redirect loops at the configured limit", async () => {
  let fetches = 0;
  await assert.rejects(
    safeDiscoveryFetch("https://loop.example/models", {}, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, { status: 302, headers: { Location: "/models" } });
      },
    }),
    /redirect limit/i,
  );
  assert.equal(fetches, 4);
});

test("safe fetch preserves loopback and LAN provider support", async () => {
  for (const target of [
    "http://127.0.0.1:8787/v1/models",
    "http://192.168.5.28:18085/v1/models",
  ]) {
    let fetched;
    const response = await safeDiscoveryFetch(target, {}, {
      fetchImpl: async (input) => {
        fetched = String(input);
        return new Response("ok");
      },
    });
    assert.equal(fetched, target);
    assert.equal(await response.text(), "ok");
  }
});

test("resolves a provider API key and headers without ModelRuntime", async () => {
  const auth = await resolveModelDiscoveryAuth("cpa", {
    baseUrl: "https://example.invalid/v1",
    api: "openai-responses",
    apiKey: "sk-test-key",
    headers: { "X-Custom": "from-request" },
  });
  assert.equal(auth.apiKey, "sk-test-key");
  assert.deepEqual(auth.headers, { "X-Custom": "from-request" });
});

test("treats command-looking API keys as inert literal text", async () => {
  const auth = await resolveModelDiscoveryAuth("temporary", {
    baseUrl: "https://example.invalid/v1",
    api: "openai-completions",
    apiKey: "!printf should-not-run",
  });
  assert.equal(auth.apiKey, "!printf should-not-run");
});

test("rejects request-body environment references instead of resolving process secrets", async () => {
  process.env.GROK_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    await assert.rejects(
      resolveModelDiscoveryAuth("pi-web-header-only-test", {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        apiKey: "${GROK_WEB_DISCOVERY_TEST_TOKEN}",
      }),
      /environment reference.*stored/i,
    );
    await assert.rejects(
      resolveModelDiscoveryAuth("pi-web-header-only-test", {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        headers: { "X-Discovery-Token": "$GROK_WEB_DISCOVERY_TEST_TOKEN" },
      }),
      /environment reference.*stored/i,
    );
  } finally {
    delete process.env.GROK_WEB_DISCOVERY_TEST_TOKEN;
  }
});

test("resolves stored environment references when the UI echoes the stored values", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-discovery-stored-env-"));
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  process.env.GROK_WEB_STORED_API_KEY = "stored-api-secret";
  process.env.GROK_WEB_STORED_HEADER = "stored-header-secret";
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: {
      cpa: {
        baseUrl: "https://example.invalid/v1/",
        api: "openai-responses",
        apiKey: "$GROK_WEB_STORED_API_KEY",
        headers: { "X-Stored": "${GROK_WEB_STORED_HEADER}" },
      },
    },
  }));
  try {
    const auth = await resolveModelDiscoveryAuth("cpa", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-responses",
      apiKey: "$GROK_WEB_STORED_API_KEY",
      headers: { "X-Stored": "${GROK_WEB_STORED_HEADER}" },
    });
    assert.equal(auth.apiKey, "stored-api-secret");
    assert.deepEqual(auth.headers, { "X-Stored": "stored-header-secret" });
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    delete process.env.GROK_WEB_STORED_API_KEY;
    delete process.env.GROK_WEB_STORED_HEADER;
    rmSync(home, { recursive: true, force: true });
  }
});

test("does not send stored credentials to a request-selected endpoint or API", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-discovery-endpoint-binding-"));
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  process.env.GROK_WEB_BOUND_SECRET = "must-not-leak";
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: {
      cpa: {
        baseUrl: "https://stored.example/v1",
        api: "openai-completions",
        apiKey: "$GROK_WEB_BOUND_SECRET",
        headers: { Authorization: "$GROK_WEB_BOUND_SECRET" },
      },
    },
  }));
  try {
    assert.deepEqual(await resolveModelDiscoveryAuth("cpa", {
      baseUrl: "https://attacker.example/v1",
      api: "openai-completions",
    }), { headers: {} });
    assert.deepEqual(await resolveModelDiscoveryAuth("cpa", {
      baseUrl: "https://stored.example/v1",
      api: "anthropic-messages",
    }), { headers: {} });
    assert.deepEqual(await resolveModelDiscoveryAuth("cpa", {
      baseUrl: "https://attacker.example/v1",
      api: "openai-completions",
      apiKey: "temporary-literal",
      headers: { Authorization: "Bearer temporary-literal" },
    }), {
      apiKey: "temporary-literal",
      headers: { Authorization: "Bearer temporary-literal" },
    });
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    delete process.env.GROK_WEB_BOUND_SECRET;
    rmSync(home, { recursive: true, force: true });
  }
});

test("request headers override stored headers case-insensitively without duplicates", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-discovery-header-case-"));
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: {
      cpa: {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        headers: { Authorization: "stored", "X-Other": "kept" },
      },
    },
  }));
  try {
    const auth = await resolveModelDiscoveryAuth("cpa", {
      baseUrl: "https://example.invalid/v1/",
      api: "openai-completions",
      headers: { authorization: "request" },
    });
    assert.equal(Object.keys(auth.headers).filter((name) => name.toLowerCase() === "authorization").length, 1);
    assert.equal(new Headers(auth.headers).get("authorization"), "request");
    assert.equal(new Headers(auth.headers).get("x-other"), "kept");
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects a request-selected model header environment name", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-discovery-model-env-reject-"));
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  process.env.GROK_WEB_ALLOWED_MODEL_HEADER = "allowed-secret";
  process.env.GROK_WEB_ATTACKER_SELECTED = "attacker-selected-secret";
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: {
      cpa: {
        models: [{ id: "grok-4.6", headers: { "X-Model": "$GROK_WEB_ALLOWED_MODEL_HEADER" } }],
      },
    },
  }));
  try {
    await assert.rejects(
      resolveModelDiscoveryAuth("cpa", {
        headers: { "X-Model": "$GROK_WEB_ATTACKER_SELECTED" },
      }, "grok-4.6"),
      /environment reference.*stored/i,
    );
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousHome;
    delete process.env.GROK_WEB_ALLOWED_MODEL_HEADER;
    delete process.env.GROK_WEB_ATTACKER_SELECTED;
    rmSync(home, { recursive: true, force: true });
  }
});

test("falls back to the stored models.json API key when the request omits it", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-discovery-auth-"));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: { cpa: {
      baseUrl: "https://example.invalid/v1",
      api: "openai-responses",
      apiKey: "sk-stored-key",
      headers: { "X-Stored": "yes" },
    } },
  }));
  try {
    const auth = await resolveModelDiscoveryAuth("cpa", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-responses",
    });
    assert.equal(auth.apiKey, "sk-stored-key");
    assert.deepEqual(auth.headers, { "X-Stored": "yes" });
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("keeps stored headers when the request sends an empty headers object", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "grok-discovery-empty-headers-"));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  writeFileSync(join(home, "models.json"), JSON.stringify({
    providers: { cpa: {
      baseUrl: "https://example.invalid/v1",
      api: "openai-responses",
      apiKey: "sk-stored-key",
      headers: { "X-Stored": "yes" },
    } },
  }));
  try {
    const auth = await resolveModelDiscoveryAuth("cpa", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-responses",
      headers: {},
    });
    assert.equal(auth.apiKey, "sk-stored-key");
    assert.deepEqual(auth.headers, { "X-Stored": "yes" });
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
