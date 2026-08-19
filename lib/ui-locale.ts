import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Locale } from "./i18n/types.ts";
import { grokHome } from "./grok-home.ts";

function defaultLocaleDir(): string {
  return grokHome();
}

const FILE_NAME = "ui-locale";

export function parseUiLocale(value: unknown): Locale | null {
  return value === "en" || value === "zh-CN" ? value : null;
}

export function readUiLocale(agentDir = defaultLocaleDir()): Locale | null {
  try {
    return parseUiLocale(readFileSync(join(agentDir, FILE_NAME), "utf8").trim());
  } catch {
    return null;
  }
}

export function writeUiLocale(value: unknown, agentDir = defaultLocaleDir()): Locale | null {
  const locale = parseUiLocale(value);
  if (!locale) return null;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, FILE_NAME), `${locale}\n`, "utf8");
  return locale;
}
