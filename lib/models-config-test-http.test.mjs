import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./models-config-test-http.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { POST } = await jiti.import("./models-config-test-http.ts");

function request(body) {
  return new Request("http://127.0.0.1/api/models-config/test", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1" },
    body,
  });
}

test("model test route does not use Pi ModelRuntime or completeSimple", () => {
  assert.doesNotMatch(source, /ModelRuntime/);
  assert.doesNotMatch(source, /completeSimple/);
  assert.doesNotMatch(source, /pi-stubs\/ai-compat/);
  assert.match(source, /testModelConnection/);
});

test("model test route returns typed 400 responses for malformed and missing input", async () => {
  const malformed = await POST(request("{"));
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/i);

  const missing = await POST(request(JSON.stringify({ providerName: "x" })));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /provider/i);
});

test("model test route returns 400 for blocked targets", async () => {
  const response = await POST(request(JSON.stringify({
    providerName: "x",
    provider: {
      baseUrl: "http://169.254.169.254/v1",
      api: "openai-completions",
      apiKey: "temporary-literal",
    },
    model: { id: "x" },
  })));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /link-local|special-use/i);
});

test("model test route returns 400 for request-selected environment credentials", async () => {
  const response = await POST(request(JSON.stringify({
    providerName: "x",
    provider: {
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      apiKey: "$REQUEST_SELECTED_SECRET",
    },
    model: { id: "x" },
  })));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /environment reference.*stored/i);
});
