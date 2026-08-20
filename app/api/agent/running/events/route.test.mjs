import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("running SSE clears both intervals on request abort and reader cancel", async (t) => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = [];
  let clearCalls = 0;
  globalThis.setInterval = (fn, delay) => {
    const interval = { fn, delay, active: true };
    intervals.push(interval);
    return interval;
  };
  globalThis.clearInterval = (interval) => {
    if (!interval.active) return;
    interval.active = false;
    clearCalls += 1;
  };

  const jiti = createJiti(import.meta.url, {
    alias: { "@": process.cwd() },
    interopDefault: true,
  });
  const runtimeModule = await jiti.import("../../../../../lib/acp/runtime.ts");
  let listCalls = 0;
  runtimeModule.setAgentRuntime({
    listBusyIds() {
      listCalls += 1;
      return [];
    },
  });
  const { GET } = await jiti.import("./route.ts");
  t.after(() => {
    runtimeModule.setAgentRuntime(undefined);
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  const abortController = new AbortController();
  const abortedResponse = await GET(new Request("http://localhost/events", {
    signal: abortController.signal,
  }));
  const abortedReader = abortedResponse.body.getReader();
  await abortedReader.read();
  assert.equal(intervals.filter((interval) => interval.active).length, 2);
  abortController.abort();
  await nextTurn();
  assert.equal(intervals.filter((interval) => interval.active).length, 0);
  assert.equal(clearCalls, 2);

  const cancelledResponse = await GET(new Request("http://localhost/events"));
  const cancelledReader = cancelledResponse.body.getReader();
  await cancelledReader.read();
  const cancelledIntervals = intervals.slice(-2);
  assert.equal(cancelledIntervals.every((interval) => interval.active), true);
  await cancelledReader.cancel();
  assert.equal(cancelledIntervals.every((interval) => !interval.active), true);
  assert.equal(clearCalls, 4);

  const callsAfterCancel = listCalls;
  for (const interval of cancelledIntervals) interval.fn();
  assert.equal(listCalls, callsAfterCancel);
});
