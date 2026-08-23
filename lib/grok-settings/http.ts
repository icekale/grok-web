import { existsSync } from "node:fs";
import { join } from "node:path";
import { grokHome } from "../grok-home.ts";
import { getAgentRuntime } from "../acp/runtime.ts";
import { readRuntimeProfile, writeRuntimeProfile, type RuntimeProfile } from "../runtime-profile.ts";
import {
  loadGrokSettings,
  writeGrokWebSettings,
  type PermissionMode,
} from "./home-config.ts";

export const legacyToRuntime = {
  ask: "default",
  auto: "auto",
  "always-approve": "bypassPermissions",
} as const;

export function runtimeToLegacy(mode: RuntimeProfile["permissionMode"]): PermissionMode {
  if (mode === "auto") return "auto";
  if (mode === "bypassPermissions") return "always-approve";
  return "ask";
}

function publicSettings(home = grokHome(), cwd?: string) {
  const settings = loadGrokSettings(home, cwd);
  const profileFile = join(home, "grok-web", "runtime-profile.json");
  const permissionMode = existsSync(profileFile) ? runtimeToLegacy(readRuntimeProfile(home).permissionMode) : settings.permissionMode;
  return {
    username: settings.username,
    web: settings.web,
    auth: settings.auth,
    mcpServers: settings.mcpServers,
    skills: settings.skills,
    permissionMode,
  };
}

export function getGrokSettings(home = grokHome(), cwd?: string): Response {
  return Response.json(publicSettings(home, cwd));
}

type SettingsRuntime = {
  applyRuntimeProfile: (profile: RuntimeProfile, store: { read: () => RuntimeProfile; write: (profile: RuntimeProfile) => void }) => Promise<{ status: "applied" | "degraded"; profile?: RuntimeProfile; error?: string; rollbackError?: string }>;
};

export async function putGrokSettings(req: Request, home = grokHome(), runtime: SettingsRuntime = getAgentRuntime()): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Settings object is required" }, { status: 400 });
  }
  const { permissionMode, ...web } = body;
  if (permissionMode !== undefined) {
    if (typeof permissionMode !== "string" || !(permissionMode in legacyToRuntime)) {
      return Response.json({ error: "permissionMode must be ask, auto, or always-approve" }, { status: 400 });
    }
    const previous = readRuntimeProfile(home);
    const next = { ...previous, permissionMode: legacyToRuntime[permissionMode as keyof typeof legacyToRuntime] };
    try {
      const result = await runtime.applyRuntimeProfile(next, { read: () => previous, write: (profile) => { writeRuntimeProfile(profile, home); } });
      if (result.status === "degraded") return Response.json(result, { status: 503 });
    } catch (error) {
      const status = typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 503;
      const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "runtime_start_failed";
      return Response.json({ error: error instanceof Error ? error.message : String(error), code }, { status });
    }
  }
  if (Object.keys(web).length > 0) writeGrokWebSettings(web, home);
  return Response.json(publicSettings(home));
}
