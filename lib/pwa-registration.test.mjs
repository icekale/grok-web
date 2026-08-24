import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCurrentGrokServiceWorker, leftoverForeignCacheNames, pwaServiceWorkerAction } from "./pwa-registration.ts";

describe("pwaServiceWorkerAction", () => {
  it("registers only in production and unregisters leftover workers in dev", () => {
    assert.equal(pwaServiceWorkerAction("production"), "register");
    assert.equal(pwaServiceWorkerAction("development"), "unregister");
    assert.equal(pwaServiceWorkerAction("test"), "unregister");
  });
});

describe("leftoverForeignCacheNames", () => {
  it("deletes leftover Pi Web caches and keeps grok-web caches", () => {
    assert.deepEqual(
      leftoverForeignCacheNames([
        "grok-web-static-0.10.0-grok-mark-2",
        "pi-web-static-0.9.0",
        "pi-web-runtime",
      ]),
      ["pi-web-static-0.9.0", "pi-web-runtime"],
    );
  });
});

describe("isCurrentGrokServiceWorker", () => {
  it("keeps only this origin's /sw.js and drops leftover Pi workers", () => {
    const origin = "http://127.0.0.1:30142";
    assert.equal(isCurrentGrokServiceWorker(`${origin}/sw.js?v=0.10.0`, origin), true);
    assert.equal(isCurrentGrokServiceWorker(`${origin}/sw.js`, origin), true);
    assert.equal(isCurrentGrokServiceWorker("http://127.0.0.1:30141/sw.js?v=pi", origin), false);
    assert.equal(isCurrentGrokServiceWorker(`${origin}/pi-sw.js`, origin), false);
  });
});
