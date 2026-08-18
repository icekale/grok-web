import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pwaServiceWorkerAction } from "./pwa-registration.ts";

describe("pwaServiceWorkerAction", () => {
  it("registers only in production and unregisters leftover workers in dev", () => {
    assert.equal(pwaServiceWorkerAction("production"), "register");
    assert.equal(pwaServiceWorkerAction("development"), "unregister");
    assert.equal(pwaServiceWorkerAction("test"), "unregister");
  });
});
