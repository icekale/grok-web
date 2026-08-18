import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promptIndexForEntry } from "./rewind-map.ts";

describe("promptIndexForEntry", () => {
  const messages = [
    { role: "user", content: "u0" },
    { role: "assistant", content: [], model: "g", provider: "grok" },
    { role: "user", content: "u1" },
    { role: "assistant", content: [], model: "g", provider: "grok" },
  ];
  const entryIds = ["e0", "e1", "e2", "e3"];

  it("maps a user entry to its prompt index", () => {
    assert.equal(promptIndexForEntry("e0", messages, entryIds), 0);
    assert.equal(promptIndexForEntry("e2", messages, entryIds), 1);
  });

  it("maps an assistant entry to the preceding user prompt", () => {
    assert.equal(promptIndexForEntry("e1", messages, entryIds), 0);
    assert.equal(promptIndexForEntry("e3", messages, entryIds), 1);
  });

  it("throws on unknown entryId", () => {
    assert.throws(() => promptIndexForEntry("missing", messages, entryIds), /entry/i);
  });
});
