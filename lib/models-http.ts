import { stat } from "fs/promises";
import { resolve } from "path";
import { getAgentRuntime } from "@/lib/acp/runtime";
import { mergeComposerModels } from "@/lib/composer-models";
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
  try {
    syncSettingsModelsToGrokConfig(settings);
    const pickerId = settingsPickerIdResolver();
    const listed = await getAgentRuntime().listModels();
    return mergeComposerModels(listed, settings, pickerId);
  } catch {
    return withSafeModelLoadFailure(mergeComposerModels(EMPTY_MODELS, settings, settingsPickerIdResolver()));
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
