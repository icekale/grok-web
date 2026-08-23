import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export const EXPECTED_ARTIFACTS = ["chronology.json", "server.log", "fixture.log", "trace.zip", "screenshot.png"];

function rootEntries(roots = new Map()) {
  return [...(roots instanceof Map ? roots.entries() : Object.entries(roots))]
    .sort(([a], [b]) => b.length - a.length);
}
function replaceRoots(value, roots) {
  let output = String(value);
  for (const [root, alias] of rootEntries(roots)) output = output.split(root).join(alias);
  return output;
}

export function redactE2eText(value, { roots = new Map(), secrets = [] } = {}) {
  let output = replaceRoots(value, roots);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(String(secret)).join("<redacted>");
  output = output
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic <redacted>")
    .replace(/((?:api[_-]?key|password|token|secret|authorization))\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/([a-z][a-z0-9+.-]*):\/\/[^\s/@:]+:[^\s/@]+@/gi, "$1://<redacted>@")
    .replace(/(?:\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\)[^\s"'<>]*/g, "<path>");
  return output;
}

export function safeArtifactEvent(input, { roots = new Map(), secrets = [] } = {}) {
  const output = {};
  for (const key of ["method", "sessionId", "testId", "timestamp", "status", "cwdAlias"]) {
    const value = input?.[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = redactE2eText(value, { roots, secrets });
  }
  if (typeof input?.cwd === "string") {
    const alias = rootEntries(roots).find(([root]) => input.cwd === root)?.[1];
    if (alias) output.cwdAlias = alias;
  }
  return output;
}

function isRetainedTraceEntry(name) {
  const lower = name.toLowerCase();
  if (lower.includes("resource") || lower.includes("screenshot") || lower.includes("source") || lower.includes("body")) return false;
  return lower.endsWith(".json") || lower.endsWith(".jsonl") || lower.endsWith(".trace");
}
function isUnsafe(text, secrets = []) {
  return secrets.some((secret) => secret && text.includes(String(secret)))
    || /Bearer\s+(?!<redacted>)[A-Za-z0-9._~+/=-]+|Basic\s+(?!<redacted>)[A-Za-z0-9+/=]+|(?:api[_-]?key|password|token|secret|authorization)\s*[:=]\s*(?!<redacted>)[^\s,;]+|\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\/i.test(text);
}

export function sanitizeTraceArchive(input, options = {}) {
  const entries = unzipSync(input);
  const retained = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (!isRetainedTraceEntry(name)) continue;
    const text = strFromU8(bytes);
    const redacted = redactE2eText(text, options);
    if (isUnsafe(redacted, options.secrets)) throw new Error(`unsafe trace entry: ${name}`);
    retained[name] = strToU8(redacted);
  }
  if (!Object.keys(retained).length) throw new Error("trace contains no safe metadata");
  const output = zipSync(retained, { level: 6 });
  const reopened = unzipSync(output);
  for (const [name, bytes] of Object.entries(reopened)) {
    const text = strFromU8(bytes);
    if (isUnsafe(text, options.secrets)) throw new Error(`unsafe sanitized trace: ${name}`);
  }
  return output;
}

export function validateArtifactDirectory(directory, options = {}) {
  const names = readdirSync(directory).sort();
  const expected = [...EXPECTED_ARTIFACTS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new Error("unexpected artifact file");
  for (const name of ["chronology.json", "server.log", "fixture.log"]) {
    const text = readFileSync(join(directory, name), "utf8");
    const redacted = redactE2eText(text, options);
    if (isUnsafe(redacted, options.secrets)) throw new Error(`unsafe artifact: ${name}`);
  }
  const trace = sanitizeTraceArchive(readFileSync(join(directory, "trace.zip")), options);
  writeFileSync(join(directory, "trace.zip"), trace);
  const screenshot = readFileSync(join(directory, "screenshot.png"));
  if (!screenshot.length) throw new Error("empty screenshot artifact");
  return true;
}

export function writeSafeArtifactEvent(path, event, options = {}) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(safeArtifactEvent(event, options))}\n`, { flag: "a" });
}
