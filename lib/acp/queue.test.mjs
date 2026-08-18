import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionQueue } from "./queue.ts";

describe("SessionQueue", () => {
  it("enqueues, edits, removes, and clears follow-ups", () => {
    const q = new SessionQueue();
    q.enqueue("followUp", "a");
    q.enqueue("followUp", "b");
    q.enqueue("steering", "s");
    assert.deepEqual(q.snapshot(), { steering: ["s"], followUp: ["a", "b"] });
    assert.deepEqual(q.edit("followUp", "a", "A"), { steering: ["s"], followUp: ["A", "b"] });
    assert.deepEqual(q.remove("followUp", "b"), { steering: ["s"], followUp: ["A"] });
    const cleared = q.clear();
    assert.deepEqual(cleared, { steering: ["s"], followUp: ["A"] });
    assert.deepEqual(q.snapshot(), { steering: [], followUp: [] });
  });

  it("takeSteerItem pulls one follow-up and leaves the rest", () => {
    const q = new SessionQueue();
    q.enqueue("followUp", "a");
    q.enqueue("followUp", "b");
    assert.equal(q.take("followUp", "a"), "a");
    assert.deepEqual(q.snapshot(), { steering: [], followUp: ["b"] });
  });

  it("rejects empty edit replacement", () => {
    const q = new SessionQueue();
    q.enqueue("followUp", "a");
    assert.throws(() => q.edit("followUp", "a", "  "), /empty/i);
  });
});
