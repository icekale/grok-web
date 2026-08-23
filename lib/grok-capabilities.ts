import { execFile as nodeExecFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileDefault = promisify(nodeExecFile);
const cache = new Map<string, GrokCapabilities>();

export function clearGrokCapabilitiesCache(): void {
  cache.clear();
}

export type GrokCapabilities = {
  version: string;
  globalFlags: Set<string>;
  agentFlags: Set<string>;
  stdioFlags: Set<string>;
  agents: Array<{ name: string; description?: string; source?: Record<string, unknown> }>;
  warnings: string[];
};

type CapabilityDeps = {
  execFile?: (binary: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout?: string; stderr?: string }>;
  stat?: (binary: string) => Promise<{ mtimeMs: number; size: number }>;
};

export function parseCapabilityFlags(text: string): Set<string> {
  return new Set(text.match(/--[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []);
}
function empty(): GrokCapabilities {
  return { version: "unknown", globalFlags: new Set(), agentFlags: new Set(), stdioFlags: new Set(), agents: [], warnings: [] };
}
function warning(text: string): string {
  return text.replace(/(?:[A-Za-z]:\\|\\\\|\/(?!\/))[^\s"'<>]*/g, "<path>").slice(0, 240);
}
function parseAgents(text: string): Array<{ name: string; description?: string; source?: Record<string, unknown> }> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { agents?: unknown }).agents)) return [];
    return (parsed as { agents: unknown[] }).agents.filter((agent): agent is Record<string, unknown> => (
      agent !== null && typeof agent === "object" && typeof (agent as { name?: unknown }).name === "string"
      && ((agent as { source?: unknown }).source === undefined || (agent as { source?: unknown }).source !== null && typeof (agent as { source?: unknown }).source === "object")
    )).map((agent) => ({
      name: String(agent.name),
      ...(typeof agent.description === "string" ? { description: agent.description.slice(0, 240) } : {}),
      ...(agent.source && typeof agent.source === "object" ? { source: agent.source as Record<string, unknown> } : {}),
    }));
  } catch {
    return [];
  }
}

export async function discoverGrokCapabilities(binary: string, deps: CapabilityDeps = {}): Promise<GrokCapabilities> {
  const execFile = deps.execFile ?? (async (file, args, options) => execFileDefault(file, args, options as never) as never);
  const stat = deps.stat ?? (async (file) => statSync(file));
  let identity: string;
  let file = binary;
  try { file = realpathSync(binary); } catch { /* injected or not-yet-existing binaries use the supplied path */ }
  try {
    const info = await stat(file);
    identity = `${file}:${info.mtimeMs}:${info.size}`;
  } catch {
    identity = file;
  }
  const cached = cache.get(identity);
  if (cached) return clone(cached);
  const result = empty();
  const probe = async (args: string[]): Promise<string> => {
    try {
      const output = await execFile(binary, args, { timeout: 10_000, maxBuffer: 512 * 1024 });
      return typeof output.stdout === "string" ? output.stdout : "";
    } catch (error) {
      result.warnings.push(`capability probe failed: ${warning(error instanceof Error ? error.message : String(error))}`);
      return "";
    }
  };
  const version = await probe(["--version"]);
  result.version = version.trim().split(/\r?\n/, 1)[0]?.slice(0, 100) || "unknown";
  result.globalFlags = parseCapabilityFlags(await probe(["--help"]));
  result.agentFlags = parseCapabilityFlags(await probe(["agent", "--help"]));
  result.stdioFlags = parseCapabilityFlags(await probe(["agent", "stdio", "--help"]));
  result.agents = parseAgents(await probe(["inspect", "--json"]));
  cache.set(identity, clone(result));
  return result;
}

function clone(value: GrokCapabilities): GrokCapabilities {
  return { ...value, globalFlags: new Set(value.globalFlags), agentFlags: new Set(value.agentFlags), stdioFlags: new Set(value.stdioFlags), agents: value.agents.map((agent) => ({ ...agent, ...(agent.source ? { source: { ...agent.source } } : {}) })), warnings: [...value.warnings] };
}
