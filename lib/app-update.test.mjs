import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { currentUpdateStatus, isNewerStableVersion } = await jiti.import("./app-update.ts");

test("detects newer stable versions", () => {
  assert.equal(isNewerStableVersion("0.8.8", "0.8.7"), true);
  assert.equal(isNewerStableVersion("0.9.0", "0.8.7"), true);
  assert.equal(isNewerStableVersion("1.0.0", "0.9.9"), true);
});

test("does not report equal, older, or unsupported versions as updates", () => {
  assert.equal(isNewerStableVersion("0.8.7", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.6", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.8-beta.1", "0.8.7"), false);
  assert.equal(isNewerStableVersion("invalid", "0.8.7"), false);
});

test("does not advertise a Pi Web npm release as a Grok Web update", () => {
  assert.deepEqual(currentUpdateStatus("0.14.5"), {
    currentVersion: "0.14.5",
    latestVersion: "0.14.5",
    updateAvailable: false,
    releaseUrl: "",
  });
});

test("app update route does not query the Pi Web npm package", async () => {
  const route = await readFile(new URL("../app/api/app-update/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /pi-web|@agegr|getPiWebReleaseUrl|registry\.npmjs\.org/);
  assert.match(route, /currentUpdateStatus/);
});
