import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { grokHome } from "./grok-home.ts";

export function readMemoryEnabled(text: string): boolean {
  const block = /^\[memory\][^\[]*/m.exec(text)?.[0] ?? "";
  return /^[ \t]*enabled\s*=\s*true\b/m.test(block);
}

export function pinMemoryEnabled(text: string, enabled: boolean): string {
  const line = `enabled = ${enabled ? "true" : "false"}`;
  const match = /^\[memory\][^\[]*/m.exec(text);
  if (!match) {
    const suffix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    return `${text}${suffix}[memory]\n${line}\n`;
  }
  const block = match[0];
  const nextBlock = /^[ \t]*enabled\s*=.*$/m.test(block)
    ? block.replace(/^[ \t]*enabled\s*=.*$/m, line)
    : block.replace(/\[memory\]\s*\n?/, `[memory]\n${line}\n`);
  return `${text.slice(0, match.index)}${nextBlock}${text.slice(match.index + block.length)}`;
}

export function pinGrokMemoryEnabled(enabled: boolean, home = grokHome()): void {
  const file = join(home, "config.toml");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = pinMemoryEnabled(current, enabled);
  if (next !== current) writePrivateFileAtomicSync(file, next);
}

export function originIdentity(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!cleaned) return null;
  const ssh = /^git@[^:]+:(.+)$/.exec(cleaned);
  if (ssh) return ssh[1].replace(/^\/+/, "") || null;
  try {
    const parsed = new URL(cleaned);
    return parsed.pathname.replace(/^\/+/, "") || null;
  } catch {
    return null;
  }
}

function gitOriginUrl(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function workspaceMemoryDirName(identity: string): string {
  const slug = identity.replaceAll("/", "-").replace(/^-+/, "") || "workspace";
  const hash = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export function workspaceMemoryDir(cwd: string, home = grokHome()): string {
  const origin = gitOriginUrl(cwd);
  const identity = (origin && originIdentity(origin)) || cwd;
  return join(home, "memory", workspaceMemoryDirName(identity));
}

export function appendRememberNote(file: string, text: string, now = new Date()): void {
  const note = text.trim();
  if (!note) throw new Error("remember text is required");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const day = now.toISOString().slice(0, 10);
  const previous = existsSync(file) ? readFileSync(file, "utf8") : "";
  const prefix = previous.length === 0 || previous.endsWith("\n") ? "" : "\n";
  writePrivateFileAtomicSync(file, `${previous}${prefix}\n## Note\n\n- ${day}: ${note}\n`);
}

export function assertSessionLogPath(target: string, home = grokHome()): string {
  const resolved = realpathSync(target);
  const root = realpathSync(join(home, "memory"));
  const sessionsMarker = `${sep}sessions${sep}`;
  if (!resolved.startsWith(root + sep) || !resolved.includes(sessionsMarker)) {
    throw new Error("Only session memory logs can be deleted");
  }
  if (resolved.endsWith(`${sep}MEMORY.md`)) {
    throw new Error("Only session memory logs can be deleted");
  }
  return resolved;
}
