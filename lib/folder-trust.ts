import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { grokHome } from "./grok-home.ts";

function canonicalFolder(path: string): string {
  if (!path.startsWith(sep) && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error("over-broad folder-trust path");
  }
  const absolute = resolve(path);
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    resolved = absolute;
  }
  const home = resolve(homedir());
  if (resolved === sep || resolved === home) {
    throw new Error("over-broad folder-trust path");
  }
  return resolved;
}

function escapeTomlKey(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function unescapeTomlKey(path: string): string {
  return path.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

export function encodeTrustedFolders(paths: string[], decidedAt = Math.floor(Date.now() / 1000)): string {
  const unique = [...new Set(paths.map((path) => canonicalFolder(path)))].sort();
  if (unique.length === 0) return "";
  const stamp = Number.isFinite(decidedAt) ? Math.trunc(decidedAt) : Math.floor(Date.now() / 1000);
  return unique.map((path) => (
    `[folders."${escapeTomlKey(path)}"]\ntrusted = true\ndecided_at = ${stamp}\n`
  )).join("\n");
}

export function parseTrustedFolders(text: string): string[] {
  const folders: string[] = [];
  let current: string | null = null;
  let trusted = false;
  const flush = () => {
    if (current && trusted) folders.push(current);
    current = null;
    trusted = false;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[folders\."(.*)"\]$/.exec(line);
    if (header) {
      flush();
      current = unescapeTomlKey(header[1]);
      continue;
    }
    if (current !== null && /^trusted\s*=\s*true\b/.test(line)) trusted = true;
  }
  flush();
  return [...new Set(folders)];
}

export function readFolderTrust(home = grokHome()): string[] {
  const file = join(home, "trusted_folders.toml");
  if (!existsSync(file)) return [];
  try {
    return parseTrustedFolders(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function writeFolderTrust(folders: string[], home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, "trusted_folders.toml");
  writePrivateFileAtomicSync(file, encodeTrustedFolders(folders));
}

export function trustFolder(path: string, home = grokHome()): void {
  const next = canonicalFolder(path);
  writeFolderTrust([...readFolderTrust(home), next], home);
}

export function untrustFolder(path: string, home = grokHome()): void {
  const next = canonicalFolder(path);
  writeFolderTrust(readFolderTrust(home).filter((folder) => folder !== next), home);
}

export function readFolderTrustEnabled(
  home = grokHome(),
  env = process.env.GROK_FOLDER_TRUST,
): boolean {
  const raw = env?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  const file = join(home, "config.toml");
  if (!existsSync(file)) return true;
  const block = /^\[folder_trust\][^\[]*/m.exec(readFileSync(file, "utf8"))?.[0] ?? "";
  return !/^[ \t]*enabled\s*=\s*false\b/m.test(block);
}
