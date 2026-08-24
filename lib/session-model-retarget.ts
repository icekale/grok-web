import { collectSettingsComposerModels, isOfficialGrokCatalogModel, type SettingsComposerModel } from "./composer-models.ts";
import { composerDisplayId } from "./grok-model-label.ts";
import { grokSettingsPickerId } from "./grok-model-table.ts";
import { readModelsConfig } from "./models-config-store.ts";

type RetargetRuntime = {
  send(sessionId: string, command: { type: string; [key: string]: unknown }): Promise<unknown>;
};

export type VisibleModelFallback = { provider: string; modelId: string };

export function settingsFallbackFor(
  modelId: string,
  rows: SettingsComposerModel[] = collectSettingsComposerModels(readModelsConfig()),
): VisibleModelFallback | null {
  if (rows.length === 0) return null;
  const display = composerDisplayId(modelId);
  const match = rows.find((row) => composerDisplayId(row.id) === "grok-4.6")
    ?? rows.find((row) => row.id === display || grokSettingsPickerId(row) === modelId)
    ?? rows[0];
  return { provider: match.providerId, modelId: grokSettingsPickerId(match) };
}

export async function ensurePromptUsesVisibleModel(
  runtime: RetargetRuntime,
  sessionId: string,
  deps: {
    officialConnected?: () => boolean | Promise<boolean>;
    fallback?: VisibleModelFallback | null;
  } = {},
): Promise<void> {
  const officialConnected = await (deps.officialConnected ?? (await import("./auth-providers-http.ts")).resolveOfficialGrokConnected)();
  if (officialConnected) return;

  const state = await runtime.send(sessionId, { type: "get_state" }) as {
    model?: { provider?: unknown; id?: unknown };
  };
  const modelId = typeof state.model?.id === "string" ? state.model.id : "";
  const provider = typeof state.model?.provider === "string" ? state.model.provider : "grok";
  if (!modelId || !isOfficialGrokCatalogModel({ id: modelId, provider })) return;

  const fallback = deps.fallback === undefined ? settingsFallbackFor(modelId) : deps.fallback;
  if (!fallback) return;
  await runtime.send(sessionId, { type: "set_model", provider: fallback.provider, modelId: fallback.modelId });
}
