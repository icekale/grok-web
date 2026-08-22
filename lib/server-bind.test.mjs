import assert from "node:assert/strict";
import test from "node:test";
import { assertServerBindAllowed } from "./server-bind.ts";

test("direct Nitro non-loopback bind requires a password", () => {
  assert.throws(() => assertServerBindAllowed({ NITRO_HOST: "0.0.0.0" }, false), /refuses|password/i);
  assert.doesNotThrow(() => assertServerBindAllowed({ NITRO_HOST: "127.0.0.1" }, false));
  assert.doesNotThrow(() => assertServerBindAllowed({ NITRO_HOST: "0.0.0.0" }, true));
});

test("server bind uses the same host precedence as Nitro startup", () => {
  assert.throws(() => assertServerBindAllowed({ HOST: "0.0.0.0" }, undefined), /0\.0\.0\.0/);
  assert.doesNotThrow(() => assertServerBindAllowed({ NITRO_HOST: "127.0.0.1", HOST: "0.0.0.0" }, undefined));
});
