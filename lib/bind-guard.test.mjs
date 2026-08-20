import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertBindAllowed, isLoopbackHost } from "./bind-guard.ts";

describe("bind-guard", () => {
  it("allows loopback without a password", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.doesNotThrow(() => assertBindAllowed("127.0.0.1", undefined));
  });

  it("rejects 0.0.0.0 without a password", () => {
    assert.throws(() => assertBindAllowed("0.0.0.0", undefined), /refuses|GROK_WEB_PASSWORD/);
  });

  it("allows 0.0.0.0 with a password", () => {
    assert.doesNotThrow(() => assertBindAllowed("0.0.0.0", "long-enough-secret"));
  });

  it("allows 0.0.0.0 when a file-stored password is enabled", () => {
    assert.doesNotThrow(() => assertBindAllowed("0.0.0.0", true));
  });
});
