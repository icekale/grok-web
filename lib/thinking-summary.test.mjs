import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractThinkingSummary } from "./thinking-summary.ts";

describe("extractThinkingSummary", () => {
  it("prefers the first bold span, then a heading, then the first real line", () => {
    assert.equal(extractThinkingSummary("Let me **inspect the runtime** first."), "inspect the runtime");
    assert.equal(extractThinkingSummary("## Plan\n\n- inspect\n- fix"), "Plan");
    assert.equal(extractThinkingSummary("Looking at spawn flags next."), "Looking at spawn flags next.");
  });

  it("returns null for empty or tiny noise", () => {
    assert.equal(extractThinkingSummary(""), null);
    assert.equal(extractThinkingSummary("  \n> \n- "), null);
    assert.equal(extractThinkingSummary("…"), null);
  });
});
