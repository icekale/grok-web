import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, unzipSync, strFromU8, strToU8 } from "fflate";
import test from "node:test";

const {
  safeArtifactEvent,
  redactE2eText,
  sanitizeTraceArchive,
  validateArtifactDirectory,
} = await import("./e2e-artifacts.mjs");

const roots = new Map([
  ["/tmp/a", "<project-a>"],
  ["/tmp/home", "<grok-home>"],
  ["/tmp/fixture", "<fixture>"],
]);

test("safeArtifactEvent copies only allowlisted safe fields", () => {
  const unsafe = {
    method: "session/prompt",
    cwd: "/Users/person/private/repo",
    authorization: "Bearer secret-token",
    apiKey: "sk-secret",
    prompt: "private user prompt",
    testId: "stream-text",
  };
  const safe = safeArtifactEvent(unsafe, { roots });
  assert.deepEqual(safe, { method: "session/prompt", testId: "stream-text" });
  assert.doesNotMatch(JSON.stringify(safe), /secret|private user|\/Users\/person/);
});

test("redactE2eText masks credentials and runner paths", () => {
  const text = [
    "Authorization: Bearer super-secret-token",
    "authorization=Basic dXNlcjpwYXNz",
    "apiKey=sk-live-secret password: hidden token=abc",
    "https://user:password@example.com/private",
    "/tmp/a/file.ts /tmp/home/auth.json /tmp/fixture/acp-agent.mjs",
    "cwd:/Users/person/private/repo/file.ts /tmp/other-user/file.ts /var/log/private.log \\\\server\\share\\secret.txt",
  ].join("\n");
  const redacted = redactE2eText(text, { roots, secrets: ["super-secret-token", "private"] });
  assert.doesNotMatch(redacted, /super-secret-token|dXNlcjpwYXNz|sk-live-secret|hidden|abc|user:password|\/Users\/person|server\\\\share/);
  assert.match(redacted, /<project-a>|<grok-home>|<fixture>/);
});

test("sanitizeTraceArchive drops bodies/resources and revalidates retained strings", () => {
  const input = zipSync({
    "trace.trace": strToU8(JSON.stringify({ title: "<project-a>/run", secret: "Bearer trace-secret", apiKey: "quoted-trace-secret" })),
    "trace.network": strToU8(JSON.stringify({ url: "https://user:pass@example.com", body: "private" })),
    "resources/secret.txt": strToU8("apiKey=trace-secret"),
    "screenshot/shot.png": new Uint8Array([1, 2, 3]),
    "test-source.ts": strToU8("/Users/person/private/repo"),
  });
  const output = sanitizeTraceArchive(input, { roots, secrets: ["trace-secret", "quoted-trace-secret", "private"] });
  const entries = unzipSync(output);
  assert.deepEqual(Object.keys(entries), ["trace.trace"]);
  const trace = strFromU8(entries["trace.trace"]);
  assert.doesNotMatch(trace, /trace-secret/);
  assert.doesNotMatch(trace, /<project-a>\/run/);
});

test("validateArtifactDirectory rejects extra files and unsafe retained trace data", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-web-artifacts-test-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chronology.json"), "[]");
  writeFileSync(join(dir, "server.log"), "ok");
  writeFileSync(join(dir, "fixture.log"), "ok");
  writeFileSync(join(dir, "screenshot.png"), "png");
  writeFileSync(join(dir, "trace.zip"), Buffer.from(zipSync({ "trace.trace": strToU8("secret-token") })));
  writeFileSync(join(dir, "raw.json"), "must reject");
  assert.throws(() => validateArtifactDirectory(dir, { roots, secrets: ["secret-token"] }), /unexpected artifact|unsafe artifact/i);
});
