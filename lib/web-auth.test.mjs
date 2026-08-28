import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-auth-"));
const previousGrokHome = process.env.GROK_HOME;
process.env.GROK_HOME = agentDir;
after(() => {
  if (previousGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousGrokHome;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  moduleCache: false,
});

async function loadSubject() {
  return jiti.import("./web-auth.ts");
}

function authorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

test("enables password authentication only for a 12-256 character configured password", async () => {
  const { isWebPasswordEnabled } = await loadSubject();
  assert.equal(isWebPasswordEnabled(undefined), false);
  assert.equal(isWebPasswordEnabled(""), false);
  assert.equal(isWebPasswordEnabled("secret"), false);
  assert.equal(isWebPasswordEnabled("x".repeat(11)), false);
  assert.equal(isWebPasswordEnabled("twelve chars!"), true);
  assert.equal(isWebPasswordEnabled("x".repeat(256)), true);
  assert.equal(isWebPasswordEnabled("x".repeat(257)), false);
});

test("accepts only the fixed grok username and configured password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(await isValidBasicAuthorization(authorization("grok", "twelve chars!"), "twelve chars!"), true);
  assert.equal(await isValidBasicAuthorization(authorization("pi", "twelve chars!"), "twelve chars!"), false);
  assert.equal(await isValidBasicAuthorization(authorization("admin", "twelve chars!"), "twelve chars!"), false);
  assert.equal(await isValidBasicAuthorization(authorization("grok", "wrong"), "twelve chars!"), false);
});

test("supports UTF-8 passwords and colons in the password", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const password = "口令:with:colons";
  assert.equal(await isValidBasicAuthorization(authorization("grok", password), password), true);
});

test("rejects missing, malformed, and non-canonical authorization values", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  const valid = authorization("grok", "twelve chars!");

  assert.equal(await isValidBasicAuthorization(null, "twelve chars!"), false);
  assert.equal(await isValidBasicAuthorization("Bearer token", "twelve chars!"), false);
  assert.equal(await isValidBasicAuthorization("Basic !!!", "twelve chars!"), false);
  assert.equal(await isValidBasicAuthorization(`${valid}!`, "twelve chars!"), false);
  assert.equal(await isValidBasicAuthorization(
    `Basic ${Buffer.from("missing-separator", "utf8").toString("base64")}`,
    "twelve chars!",
  ), false);
});

test("does not authenticate when password protection is disabled", async () => {
  const { isValidBasicAuthorization } = await loadSubject();
  assert.equal(await isValidBasicAuthorization(authorization("grok", ""), ""), false);
  assert.equal(await isValidBasicAuthorization(authorization("grok", "twelve chars!"), undefined), false);
});

test("file password authenticates when env is unset, and env wins over the file hash", async () => {
  const { writeRemoteAccessConfig } = await jiti.import("./remote-access-config.ts");
  const written = writeRemoteAccessConfig({
    allowedHosts: [],
    password: "twelve chars!",
    loopbackRequest: true,
  });
  assert.equal(written.ok, true);

  const {
    isBasicAuthorizationCached,
    isWebPasswordEnabled,
    isValidBasicAuthorization,
  } = await loadSubject();
  assert.equal(isWebPasswordEnabled(), true);
  assert.equal(await isValidBasicAuthorization(authorization("grok", "twelve chars!")), true);
  assert.equal(isBasicAuthorizationCached(authorization("grok", "twelve chars!")), true);
  assert.equal(await isValidBasicAuthorization(authorization("grok", "wrong password")), false);

  assert.equal(
    isBasicAuthorizationCached(authorization("grok", "twelve chars!"), "env-password-ok"),
    false,
  );
  assert.equal(await isValidBasicAuthorization(authorization("grok", "env-password-ok"), "env-password-ok"), true);
  assert.equal(await isValidBasicAuthorization(authorization("grok", "twelve chars!"), "env-password-ok"), false);
});
