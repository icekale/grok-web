import { stat } from "fs/promises";
import { resolve } from "path";
import { getAgentRuntime } from "@/lib/acp/runtime";
import { resolveOfficialGrokConnected } from "@/lib/auth-providers-http";
import { collectSettingsComposerModels, mergeComposerModels } from "@/lib/composer-models";
import { settingsPickerIdResolver, syncSettingsModelsToGrokConfig } from "@/lib/grok-model-table";
import { readModelsConfig } from "@/lib/models-config-store";
import {
  invalidateModelsCache,
  loadModelsWithCache,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

async function loadModels(): Promise<ModelsData> {
  const settings = readModelsConfig();
  const officialGrokConnected = await resolveOfficialGrokConnected();
  try {
    const wrote = syncSettingsModelsToGrokConfig(settings);
    if (wrote.length > 0) await getAgentRuntime().recycleProcessAndReload();
    const pickerId = settingsPickerIdResolver();
    let listed = await getAgentRuntime().listModels();
    const needed = collectSettingsComposerModels(settings)
      .filter((row) => row.baseUrl)
      .map((row) => pickerId(row));
    const have = new Set(listed.modelList.map((model) => model.id));
    if (needed.some((id) => !have.has(id))) {
      await getAgentRuntime().recycleProcessAndReload();
      listed = await getAgentRuntime().listModels();
    }
    return mergeComposerModels(listed, settings, pickerId, officialGrokConnected);
  } catch {
    return withSafeModelLoadFailure(mergeComposerModels(EMPTY_MODELS, settings, settingsPickerIdResolver(), officialGrokConnected));
  }
}

invalidateModelsCache();

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = resolve(requestedCwd);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModels()));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
