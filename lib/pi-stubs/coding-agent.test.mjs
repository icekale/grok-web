import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Theme } from "./coding-agent.ts";

describe("Theme stub", () => {
  it("is constructable and extendable", () => {
    class T extends Theme {}
    assert.ok(new Theme() instanceof Theme);
    assert.ok(new T() instanceof Theme);
  });
});
