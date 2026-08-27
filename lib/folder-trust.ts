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

export function encodeTrustedFolders(paths: string[], decidedAt = new Date().toISOString()): string {
  const unique = [...new Set(paths.map((path) => canonicalFolder(path)))].sort();
  if (unique.length === 0) return "";
  return unique.map((path) => {
    const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `[[folders]]\npath = "${escaped}"\ndecided_at = "${decidedAt}"\n`;
  }).join("\n");
}

export function parseTrustedFolders(text: string): string[] {
  const folders: string[] = [];
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[folders]]") {
      current = "";
      continue;
    }
    const match = /^path\s*=\s*"(.*)"$/.exec(line);
    if (match && current !== null) {
      folders.push(match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\"));
      current = null;
    }
  }
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

function writeFolderTrust(folders: string[], home: string, decidedAt?: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, "trusted_folders.toml");
  const text = encodeTrustedFolders(folders, decidedAt);
  writePrivateFileAtomicSync(file, text);
}

export function trustFolder(path: string, home = grokHome()): void {
  const next = canonicalFolder(path);
  writeFolderTrust([...readFolderTrust(home), next], home);
}

export function untrustFolder(path: string, home = grokHome()): void {
  const next = canonicalFolder(path);
  writeFolderTrust(readFolderTrust(home).filter((folder) => folder !== next), home);
}
