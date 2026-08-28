import assert from "node:assert/strict";
import test from "node:test";
import { parseGrokTurnUsage } from "./grok-usage.ts";

test("maps Grok turn usage so cache read is not double-counted in input", () => {
  const usage = parseGrokTurnUsage({
    inputTokens: 588967,
    outputTokens: 6411,
    totalTokens: 595378,
    cachedReadTokens: 424064,
    cacheCreationTokens: 0,
    reasoningTokens: 3125,
    costUsdTicks: 986516800,
  });
  assert.deepEqual(usage, {
    input: 164903,
    output: 6411,
    cacheRead: 424064,
    cacheWrite: 0,
    reasoning: 3125,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.9865168 },
  });
});

test("returns undefined when the update has no token fields", () => {
  assert.equal(parseGrokTurnUsage(undefined), undefined);
  assert.equal(parseGrokTurnUsage({}), undefined);
});
