import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { POST } = await jiti.import("./models-config-discover-http.ts");

function request(body) {
  return new Request("http://127.0.0.1/api/models-config/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("discovery route returns typed 400 responses for malformed and missing input", async () => {
  const malformed = await POST(request("{"));
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/i);

  const missing = await POST(request(JSON.stringify({ providerName: "x" })));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /provider/i);
});

test("discovery route returns 400 for blocked targets", async () => {
  const response = await POST(request(JSON.stringify({
    providerName: "x",
    provider: {
      baseUrl: "http://169.254.169.254/v1",
      api: "openai-completions",
      apiKey: "temporary-literal",
    },
  })));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /link-local|special-use/i);
});
