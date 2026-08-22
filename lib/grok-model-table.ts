import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { collectSettingsComposerModels, type SettingsComposerModel } from "./composer-models.ts";
import { grokHome } from "./grok-home.ts";

export function grokApiBackend(api?: string): "responses" | "chat_completions" | "messages" {
  if (api === "openai-responses") return "responses";
  if (api === "anthropic-messages") return "messages";
  return "chat_completions";
}

export function grokModelSectionNames(modelId: string): string[] {
  return [`model."${modelId}"`, `model.${modelId}`];
}

export function configHasModelSection(text: string, modelId: string): boolean {
  const names = new Set(grokModelSectionNames(modelId));
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^\[([^\]]+)\]$/);
    if (match && names.has(match[1])) return true;
  }
  return false;
}

export function grokSettingsPickerId(row: SettingsComposerModel, _configText?: string): string {
  return `${row.providerId}/${row.id}`;
}

/** Namespaced Settings tables look like `model."Cursor/grok-4.5"`. Official Grok ids have no slash. */
export function settingsManagedPickerId(sectionName: string): string | undefined {
  const match = sectionName.match(/^model\.(.+)$/);
  if (!match) return undefined;
  let id = match[1];
  if (
    (id.startsWith('"') && id.endsWith('"'))
    || (id.startsWith("'") && id.endsWith("'"))
  ) {
    id = id.slice(1, -1);
  }
  return id.includes("/") ? id : undefined;
}

type TomlSectionRange = { start: number; end: number; name: string };

function tomlSectionRanges(text: string): TomlSectionRange[] {
  const matches = [...text.matchAll(/^[ \t]*\[([^\]]+)\][ \t]*(?:#.*)?$/gm)];
  return matches.map((match, index) => ({
    start: match.index ?? 0,
    end: matches[index + 1]?.index ?? text.length,
    name: match[1].trim(),
  }));
}

function removeTomlSections(text: string, ids: Set<string>): { text: string; removed: string[] } {
  const ranges = tomlSectionRanges(text).filter((range) => {
    const pickerId = settingsManagedPickerId(range.name);
    return pickerId !== undefined && ids.has(pickerId);
  });
  if (ranges.length === 0) return { text, removed: [] };
  let next = text;
  for (const range of [...ranges].reverse()) {
    next = `${next.slice(0, range.start)}${next.slice(range.end)}`;
  }
  return { text: next, removed: [...new Set(ranges.map((range) => settingsManagedPickerId(range.name)!))] };
}

export function grokConfigText(home = grokHome()): string {
  const file = join(home, "config.toml");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function settingsPickerIdResolver(home = grokHome()): (row: SettingsComposerModel) => string {
  const text = grokConfigText(home);
  return (row) => grokSettingsPickerId(row, text);
}

export function renderGrokModelTable(row: SettingsComposerModel, pickerId = `${row.providerId}/${row.id}`): string {
  const lines = [
    `[model.${JSON.stringify(pickerId)}]`,
    `model = ${JSON.stringify(row.id)}`,
    `name = ${JSON.stringify(row.name)}`,
    `api_backend = ${JSON.stringify(grokApiBackend(row.api))}`,
  ];
  if (row.baseUrl) lines.push(`base_url = ${JSON.stringify(row.baseUrl)}`);
  if (row.apiKey) lines.push(`api_key = ${JSON.stringify(row.apiKey)}`);
  if (row.contextWindow) lines.push(`context_window = ${row.contextWindow}`);
  return `${lines.join("\n")}\n`;
}

export function syncSettingsModelsToGrokConfig(
  settings: Record<string, unknown>,
  home = grokHome(),
): string[] {
  const rows = collectSettingsComposerModels(settings).filter((row) => row.baseUrl);
  const file = join(home, "config.toml");
  if (rows.length === 0 && !existsSync(file)) return [];
  mkdirSync(home, { recursive: true });
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const wanted = new Set(rows.map((row) => grokSettingsPickerId(row, text)));
  const unchanged = new Set<string>();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalizeEol = (value: string) => value.replace(/\r\n/g, "\n");
  const ranges = tomlSectionRanges(text);
  for (const row of rows) {
    const pickerId = grokSettingsPickerId(row, text);
    const matches = ranges.filter((range) => settingsManagedPickerId(range.name) === pickerId);
    const rendered = renderGrokModelTable(row, pickerId).replaceAll("\n", eol).trimEnd();
    if (
      matches.length === 1
      && normalizeEol(text.slice(matches[0].start, matches[0].end).trimEnd()) === normalizeEol(rendered)
    ) {
      unchanged.add(pickerId);
    }
  }
  const rewriteIds = new Set([...wanted].filter((pickerId) => !unchanged.has(pickerId)));
  const removed = removeTomlSections(text, rewriteIds);
  text = removed.text;
  const changed = new Set(removed.removed);
  for (const row of rows) {
    const pickerId = grokSettingsPickerId(row, text);
    if (unchanged.has(pickerId)) continue;
    const suffix = text.length === 0 || text.endsWith(eol) ? "" : eol;
    text = `${text}${suffix}${suffix ? "" : eol}${renderGrokModelTable(row, pickerId).replaceAll("\n", eol)}`;
    changed.add(pickerId);
  }
  if (changed.size > 0) writePrivateFileAtomicSync(file, text);
  return [...changed];
}
