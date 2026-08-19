import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file.ts";
import { grokHome, grokWebMetaDir } from "../grok-home.ts";

export type GrokSettings = {
  home: string;
  username: "grok";
  config: Record<string, unknown>;
  web: Record<string, unknown>;
  auth: { loggedIn: boolean; methods: string[] };
  mcpServers: Array<{ name: string; command?: string }>;
  skills: Array<{ name: string; path: string }>;
};

function unquote(value: string): string | boolean | number {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

export function parseSimpleToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      cursor = root;
      for (const part of section[1].split(".")) {
        const next = cursor[part];
        if (next && typeof next === "object" && !Array.isArray(next)) {
          cursor = next as Record<string, unknown>;
        } else {
          const created: Record<string, unknown> = {};
          cursor[part] = created;
          cursor = created;
        }
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    cursor[line.slice(0, eq).trim()] = unquote(line.slice(eq + 1));
  }
  return root;
}

export function readGrokConfig(home = grokHome()): Record<string, unknown> {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return {};
  return parseSimpleToml(readFileSync(file, "utf8"));
}

export function writeGrokWebSettings(settings: Record<string, unknown>, home = grokHome()): string {
  const dir = join(home, "grok-web");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

export function readGrokWebSettings(home = grokHome()): Record<string, unknown> {
  const file = join(home, "grok-web", "settings.json");
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

/** Keys before the first `[section]` header; section-local `api_key` is ignored. */
function splitTopLevelToml(text: string): { preamble: string; rest: string } {
  const match = /^\[/m.exec(text);
  if (!match || match.index === undefined) return { preamble: text, rest: "" };
  return { preamble: text.slice(0, match.index), rest: text.slice(match.index) };
}

export function hasGrokApiKey(home = grokHome()): boolean {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return false;
  return /^api_key\s*=/m.test(splitTopLevelToml(readFileSync(file, "utf8")).preamble);
}

export function writeGrokApiKey(apiKey: string, home = grokHome()): void {
  mkdirSync(home, { recursive: true });
  const file = join(home, "config.toml");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const { preamble, rest } = splitTopLevelToml(current);
  const line = `api_key = ${JSON.stringify(apiKey)}`;
  const nextPreamble = /^api_key\s*=.*$/m.test(preamble)
    ? preamble.replace(/^api_key\s*=.*$/m, line)
    : `${preamble}${preamble.length === 0 || preamble.endsWith("\n") ? "" : "\n"}${line}\n`;
  writePrivateFileAtomicSync(file, `${nextPreamble}${rest}`);
}

export function clearGrokApiKey(home = grokHome()): void {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return;
  const { preamble, rest } = splitTopLevelToml(readFileSync(file, "utf8"));
  writePrivateFileAtomicSync(file, `${preamble.replace(/^api_key\s*=.*\r?\n?/m, "")}${rest}`);
}

export function readGrokAuth(home = grokHome()): { loggedIn: boolean; methods: string[] } {
  const file = join(home, "auth.json");
  if (!existsSync(file)) return { loggedIn: false, methods: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { loggedIn: false, methods: [] };
    }
    const methods = Object.keys(parsed as Record<string, unknown>).filter((key) => !key.startsWith("_"));
    return { loggedIn: methods.length > 0, methods };
  } catch {
    return { loggedIn: false, methods: [] };
  }
}

export function listMcpServers(config: Record<string, unknown> = readGrokConfig()): Array<{ name: string; command?: string }> {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return [];
  const servers = (mcp as Record<string, unknown>).servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers as Record<string, unknown>).map(([name, value]) => {
    const command = value && typeof value === "object" && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).command === "string"
      ? (value as Record<string, unknown>).command as string
      : undefined;
    return { name, ...(command ? { command } : {}) };
  });
}

export function listGrokSkills(home = grokHome(), cwd?: string): Array<{ name: string; path: string }> {
  const skills: Array<{ name: string; path: string }> = [];
  const roots = [join(home, "skills")];
  if (cwd) roots.push(join(cwd, ".agents", "skills"));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(root, entry.name, "SKILL.md");
      if (existsSync(skillFile)) skills.push({ name: entry.name, path: skillFile });
    }
  }
  return skills;
}

export function loadGrokSettings(home = grokHome(), cwd?: string): GrokSettings {
  const config = readGrokConfig(home);
  return {
    home,
    username: "grok",
    config,
    web: readGrokWebSettings(home),
    auth: readGrokAuth(home),
    mcpServers: listMcpServers(config),
    skills: listGrokSkills(home, cwd),
  };
}

export function grokWebSettingsPath(home = grokHome()): string {
  return join(grokWebMetaDir(), "settings.json");
}
