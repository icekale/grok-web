import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { currentAppVersion, getAppVersion, hasNewBuild } = await jiti.import("./app-version.ts");

test("uses the injected app version and build id", () => {
  assert.deepEqual(currentAppVersion({
    NEXT_PUBLIC_APP_VERSION: "0.10.0",
    NEXT_PUBLIC_BUILD_ID: "0.10.0-build-a1",
  }), {
    appVersion: "0.10.0",
    buildId: "0.10.0-build-a1",
  });
});

test("falls back to the app version when a build id is unavailable", () => {
  assert.deepEqual(currentAppVersion({ NEXT_PUBLIC_APP_VERSION: "0.10.0" }), {
    appVersion: "0.10.0",
    buildId: "0.10.0",
  });
});

test("only treats two non-empty different ids as a new build", () => {
  assert.equal(hasNewBuild("old", "new"), true);
  assert.equal(hasNewBuild("same", "same"), false);
  assert.equal(hasNewBuild("", "new"), false);
  assert.equal(hasNewBuild("old", ""), false);
});

test("returns a no-store version response", async () => {
  const response = getAppVersion({
    NEXT_PUBLIC_APP_VERSION: "0.10.0",
    NEXT_PUBLIC_BUILD_ID: "build-test",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    appVersion: "0.10.0",
    buildId: "build-test",
  });
});
