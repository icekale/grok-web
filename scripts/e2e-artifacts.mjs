import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export const EXPECTED_ARTIFACTS = ["chronology.json", "server.log", "fixture.log", "trace.zip", "screenshot.png"];
const MAX_TRACE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_TRACE_ENTRIES = 100;
const MAX_TRACE_OUTPUT_BYTES = 20 * 1024 * 1024;

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
    || /Bearer\s+(?!<redacted>)[A-Za-z0-9._~+/=-]+|Basic\s+(?!<redacted>)[A-Za-z0-9+/=]+|(?:api[_-]?key|password|token|secret|authorization)\s*[:=]\s*["']?(?!<redacted>)[^\s,;"']+|\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\/i.test(text);
}

function boundedUnzip(input) {
  if (input.length > MAX_TRACE_INPUT_BYTES) throw new Error("trace input exceeds size limit");
  const entries = unzipSync(input);
  const names = Object.keys(entries);
  if (names.length > MAX_TRACE_ENTRIES) throw new Error("trace contains too many entries");
  const bytes = names.reduce((sum, name) => sum + entries[name].length, 0);
  if (bytes > MAX_TRACE_OUTPUT_BYTES) throw new Error("trace output exceeds size limit");
  return entries;
}
function sanitizeTraceValue(value, key, options) {
  if (typeof value === "string") {
    return /prompt|text|value|body|content|input|output|message|title|url|path|source|cookie|header|secret|token|password|authorization|api[_-]?key/i.test(key)
      ? "<redacted>"
      : redactE2eText(value, options);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item, key, options));
  if (value && typeof value === "object") {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/resource|screenshot|source|body/i.test(childKey)) continue;
      output[childKey] = sanitizeTraceValue(childValue, childKey, options);
    }
    return output;
  }
  return value;
}
function sanitizeTraceText(text, options) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.stringify(sanitizeTraceValue(JSON.parse(line), "", options));
    } catch {
      return redactE2eText(line, options);
    }
  }).join("\n") + (text.endsWith("\n") ? "\n" : "");
}

export function sanitizeTraceArchive(input, options = {}) {
  const entries = boundedUnzip(input);
  const retained = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (!isRetainedTraceEntry(name)) continue;
    const redacted = sanitizeTraceText(strFromU8(bytes), options);
    if (isUnsafe(redacted, options.secrets)) throw new Error(`unsafe trace entry: ${name}`);
    retained[name] = strToU8(redacted);
  }
  if (!Object.keys(retained).length) throw new Error("trace contains no safe metadata");
  const output = zipSync(retained, { level: 6 });
  const reopened = boundedUnzip(output);
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
    if (text !== redacted || isUnsafe(redacted, options.secrets)) throw new Error(`unsafe artifact: ${name}`);
  }
  const rawTrace = readFileSync(join(directory, "trace.zip"));
  const rawEntries = boundedUnzip(rawTrace);
  for (const [name, bytes] of Object.entries(rawEntries)) {
    if (isRetainedTraceEntry(name) && isUnsafe(strFromU8(bytes), options.secrets)) throw new Error(`unsafe artifact: ${name}`);
  }
  const trace = sanitizeTraceArchive(rawTrace, options);
  writeFileSync(join(directory, "trace.zip"), trace);
  const screenshot = readFileSync(join(directory, "screenshot.png"));
  if (!screenshot.length) throw new Error("empty screenshot artifact");
  return true;
}

export function writeSafeArtifactEvent(path, event, options = {}) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(safeArtifactEvent(event, options))}\n`, { flag: "a" });
}
