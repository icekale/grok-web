import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const adapterSource = await readFile(new URL("../src/routes/api/agent/$id/events.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });

test("TanStack event route adapts plain params to the existing handler", () => {
  assert.match(adapterSource, /params: Promise\.resolve\(\{ id: params\.id \}\)/);
});

test("event handler preserves headers and abort cleanup", async (t) => {
  const id = "tanstack-sse-test";
  const { AgentRuntime, resetAgentRuntime } = await jiti.import("./acp/runtime.ts");
  let unsubscribeCount = 0;
  const originalSubscribe = AgentRuntime.prototype.subscribe;
  AgentRuntime.prototype.subscribe = function subscribe(sessionId, listener) {
    const stop = originalSubscribe.call(this, sessionId, listener);
    return () => {
      unsubscribeCount += 1;
      stop();
    };
  };
  t.after(() => {
    AgentRuntime.prototype.subscribe = originalSubscribe;
    resetAgentRuntime();
  });

  const { GET } = await jiti.import("./agent-events-http.ts");
  const controller = new AbortController();
  const response = await GET(
    new Request(`http://localhost/api/agent/${id}/events`, { signal: controller.signal }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("connection"), "keep-alive");
  assert.equal(response.headers.get("x-accel-buffering"), "no");

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), ":\n\n");
  controller.abort();
  // The abort handler closes the stream synchronously, but a `connected`
  // event may already be buffered in the queue (ReadableStream.close() keeps
  // queued chunks readable). Drain until done; abort cleanup must still fire.
  const second = await reader.read();
  assert.ok(
    second.done
    || new TextDecoder().decode(second.value).includes('"type":"connected"'),
  );
  assert.equal((await reader.read()).done, true);
  assert.equal(unsubscribeCount, 1);
});
