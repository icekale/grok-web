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
  if (rows.length === 0) return [];
  mkdirSync(home, { recursive: true });
  const file = join(home, "config.toml");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const wrote: string[] = [];
  for (const row of rows) {
    const pickerId = grokSettingsPickerId(row, text);
    if (configHasModelSection(text, pickerId)) continue;
    const suffix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    text = `${text}${suffix}\n${renderGrokModelTable(row, pickerId)}`;
    wrote.push(pickerId);
  }
  if (wrote.length > 0) writePrivateFileAtomicSync(file, text);
  return wrote;
}
