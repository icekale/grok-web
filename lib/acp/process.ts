import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GrokCapabilities } from "../grok-capabilities.ts";
import { DEFAULT_RUNTIME_PROFILE, type RuntimeProfile } from "../runtime-profile.ts";
import { grokHome } from "../grok-home.ts";

export function formatGrokMissingError(): string {
  return "grok-missing: install grok (curl -fsSL https://x.ai/cli/install.sh | bash) or set GROK_BIN";
}

export function resolveGrokBin(): string {
  const override = process.env.GROK_BIN?.trim();
  if (override && existsSync(override)) return override;
  const fallback = join(grokHome(), "bin", "grok");
  if (existsSync(fallback)) return fallback;
  throw new Error(formatGrokMissingError());
}

export function grokAgentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.GROK_WEB_PASSWORD;
  return env;
}

export function grokAgentSpawnOptions(source: NodeJS.ProcessEnv = process.env): {
  stdio: ["pipe", "pipe", "inherit"];
  env: NodeJS.ProcessEnv;
  detached: boolean;
} {
  return {
    stdio: ["pipe", "pipe", "inherit"],
    env: grokAgentEnv(source),
    detached: process.platform !== "win32",
  };
}

function requireGlobal(capabilities: GrokCapabilities, flag: string): void {
  if (!capabilities.globalFlags.has(flag)) throw new Error(`Grok does not advertise ${flag}`);
}
function requireAgent(capabilities: GrokCapabilities, flag: string): void {
  if (!capabilities.agentFlags.has(flag)) throw new Error(`Grok agent does not advertise ${flag}`);
}

export function grokAgentArgs(
  profile: RuntimeProfile = DEFAULT_RUNTIME_PROFILE,
  capabilities?: GrokCapabilities,
  reasoningEffort?: string,
): string[] {
  if (!capabilities) return ["agent", "stdio"];
  const args: string[] = [];
  if (reasoningEffort && capabilities.globalFlags.has("--reasoning-effort")) {
    args.push("--reasoning-effort", reasoningEffort);
  }
  if (profile.agent) {
    requireGlobal(capabilities, "--agent");
    if (!capabilities.agents.some((agent) => agent.name === profile.agent)) throw new Error(`Unknown Grok Agent: ${profile.agent}`);
    args.push("--agent", profile.agent);
  }
  if (profile.sandbox) {
    requireGlobal(capabilities, "--sandbox");
    args.push("--sandbox", profile.sandbox);
  }
  if (profile.permissionMode !== "default") {
    requireGlobal(capabilities, "--permission-mode");
    args.push("--permission-mode", profile.permissionMode);
  }
  for (const rule of profile.allow) {
    requireGlobal(capabilities, "--allow");
    args.push("--allow", rule);
  }
  for (const rule of profile.deny) {
    requireGlobal(capabilities, "--deny");
    args.push("--deny", rule);
  }
  if (profile.disableWebSearch) { requireGlobal(capabilities, "--disable-web-search"); args.push("--disable-web-search"); }
  if (profile.disableSubagents) { requireGlobal(capabilities, "--no-subagents"); args.push("--no-subagents"); }
  if (profile.maxTurns !== null) { requireGlobal(capabilities, "--max-turns"); args.push("--max-turns", String(profile.maxTurns)); }
  if (profile.rules !== null) { requireGlobal(capabilities, "--rules"); args.push("--rules", profile.rules); }
  args.push("agent");
  if (profile.agentProfilePath) { requireAgent(capabilities, "--agent-profile"); args.push("--agent-profile", profile.agentProfilePath); }
  args.push("stdio");
  return args;
}
