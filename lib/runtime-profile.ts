import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { grokHome } from "./grok-home.ts";

export const DEFAULT_RUNTIME_PROFILE = {
  version: 1 as const,
  agent: null,
  agentProfilePath: null,
  sandbox: null,
  permissionMode: "default" as const,
  allow: [] as string[],
  deny: [] as string[],
  disableWebSearch: false,
  disableSubagents: false,
  maxTurns: null,
  rules: null,
};

export type RuntimeProfile = {
  version: 1;
  agent: string | null;
  agentProfilePath: string | null;
  sandbox: string | null;
  permissionMode: "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan";
  allow: string[];
  deny: string[];
  disableWebSearch: boolean;
  disableSubagents: boolean;
  maxTurns: number | null;
  rules: string | null;
};

type ProfileOptions = { home?: string; trustedRoots?: string[] };
const PROFILE_KEYS = new Set(Object.keys(DEFAULT_RUNTIME_PROFILE));
const MODES = new Set<RuntimeProfile["permissionMode"]>(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"]);

export function runtimeProfilePath(home = grokHome()): string {
  return join(home, "grok-web", "runtime-profile.json");
}

function cloneDefault(): RuntimeProfile {
  return { ...DEFAULT_RUNTIME_PROFILE, allow: [], deny: [] };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedString(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`${field} is invalid`);
  return value.trim();
}
function rules(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== "string")) throw new Error(`${field} is invalid`);
  const normalized = value.map((item) => item.trim());
  if (normalized.some((item) => item.length === 0 || item.length > 500)) throw new Error(`${field} is out of bounds`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} contains duplicates`);
  return normalized;
}

export function validateRuntimeProfile(input: unknown, options: ProfileOptions = {}): RuntimeProfile {
  if (!record(input)) throw new Error("runtime profile must be an object");
  for (const key of Object.keys(input)) if (!PROFILE_KEYS.has(key)) throw new Error(`unknown runtime profile field: ${key}`);
  if (input.version !== 1) throw new Error("unsupported runtime profile version");
  const agent = boundedString(input.agent, "agent", 128);
  const profilePath = boundedString(input.agentProfilePath, "agentProfilePath", 4096);
  if (agent && profilePath) throw new Error("agent and agentProfilePath conflict");
  const sandbox = boundedString(input.sandbox, "sandbox", 128);
  if (typeof input.permissionMode !== "string" || !MODES.has(input.permissionMode as RuntimeProfile["permissionMode"])) throw new Error("permissionMode is invalid");
  const allow = rules(input.allow, "allow");
  const deny = rules(input.deny, "deny");
  if (allow.some((rule) => deny.includes(rule))) throw new Error("allow and deny rules conflict");
  if (typeof input.disableWebSearch !== "boolean" || typeof input.disableSubagents !== "boolean") throw new Error("runtime profile toggles are invalid");
  if (input.maxTurns !== null && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 1000)) throw new Error("maxTurns is out of bounds");
  if (input.rules !== null && (typeof input.rules !== "string" || input.rules.trim().length === 0 || input.rules.length > 4000)) throw new Error("rules is invalid");

  let trustedProfilePath: string | null = null;
  if (profilePath) {
    if (!isAbsolute(profilePath) || !existsSync(profilePath)) throw new Error("agentProfilePath must be an existing trusted file");
    try {
      if (!statSync(profilePath).isFile()) throw new Error("agentProfilePath must be a regular file");
    } catch {
      throw new Error("agentProfilePath must be a regular file");
    }
    const roots = new Set([options.home ?? grokHome(), ...(options.trustedRoots ?? [])]);
    const realProfile = realpathSync(profilePath);
    const insideRoot = [...roots].some((root) => {
      try {
        const rel = relative(realpathSync(root), realProfile);
        return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
      } catch {
        return false;
      }
    });
    if (!insideRoot) throw new Error("agentProfilePath is outside trusted roots");
    trustedProfilePath = profilePath;
  }
  return {
    version: 1,
    agent,
    agentProfilePath: trustedProfilePath,
    sandbox,
    permissionMode: input.permissionMode as RuntimeProfile["permissionMode"],
    allow,
    deny,
    disableWebSearch: input.disableWebSearch,
    disableSubagents: input.disableSubagents,
    maxTurns: input.maxTurns as number | null,
    rules: input.rules as string | null,
  };
}

export function readRuntimeProfile(home = grokHome()): RuntimeProfile {
  const path = runtimeProfilePath(home);
  if (!existsSync(path)) return cloneDefault();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(parsed)) return cloneDefault();
    const known = Object.fromEntries([...PROFILE_KEYS].filter((key) => key in parsed).map((key) => [key, parsed[key]]));
    return validateRuntimeProfile(known, { home });
  } catch {
    return cloneDefault();
  }
}

export function writeRuntimeProfile(profile: RuntimeProfile, home = grokHome(), options: Omit<ProfileOptions, "home"> = {}): RuntimeProfile {
  const valid = validateRuntimeProfile(profile, { home, ...options });
  const path = runtimeProfilePath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(valid, null, 2)}\n`);
  chmodSync(path, 0o600);
  return valid;
}
