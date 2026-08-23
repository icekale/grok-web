import { grokHome } from "./grok-home.ts";
import { discoverGrokCapabilities } from "./grok-capabilities.ts";
import { getAgentRuntime } from "./acp/runtime.ts";
import { resolveGrokBin } from "./acp/process.ts";
import { readRuntimeProfile, readRuntimeProfileStatus, validateRuntimeProfile, writeRuntimeProfile, type RuntimeProfile } from "./runtime-profile.ts";

function capabilityJson(value: { version: string; globalFlags: Set<string>; agentFlags: Set<string>; stdioFlags: Set<string>; agents: unknown[]; warnings: string[] }) {
  return { ...value, globalFlags: [...value.globalFlags], agentFlags: [...value.agentFlags], stdioFlags: [...value.stdioFlags] };
}
function errorResponse(error: unknown): Response {
  const status = typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
  const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "invalid_profile";
  return Response.json({ error: error instanceof Error ? error.message : String(error), code }, { status });
}

export function createRuntimeProfileHandlers(deps: {
  readProfile?: () => RuntimeProfile;
  readStatus?: () => { profile: RuntimeProfile; warnings: string[] };
  writeProfile?: (profile: RuntimeProfile) => void;
  apply?: (profile: RuntimeProfile) => Promise<{ status: string; profile?: RuntimeProfile; error?: string; rollbackError?: string }>;
  discover?: () => Promise<{ version: string; globalFlags: Set<string>; agentFlags: Set<string>; stdioFlags: Set<string>; agents: unknown[]; warnings: string[] }>;
} = {}) {
  const readProfile = deps.readProfile ?? (() => readRuntimeProfile());
  const writeProfile = deps.writeProfile ?? ((profile) => { writeRuntimeProfile(profile); });
  const apply = deps.apply ?? ((profile) => getAgentRuntime().applyRuntimeProfile(profile));
  const discover = deps.discover ?? (async () => discoverGrokCapabilities(resolveGrokBin()));
  return {
    async GET(_request: Request) {
      const profileState = deps.readStatus ? deps.readStatus() : (deps.readProfile ? { profile: deps.readProfile(), warnings: [] } : readRuntimeProfileStatus());
      let capabilities;
      try { capabilities = await discover(); } catch (error) {
        capabilities = { version: "unknown", globalFlags: new Set<string>(), agentFlags: new Set<string>(), stdioFlags: new Set<string>(), agents: [], warnings: [error instanceof Error ? error.message.replace(/\/(?!\/)[^\s]+/g, "<path>") : "capability discovery unavailable"] };
      }
      return Response.json({ profile: profileState.profile, capabilities: capabilityJson(capabilities), warnings: profileState.warnings, restartRequired: false });
    },
    async PUT(request: Request) {
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON", code: "invalid_profile" }, { status: 400 }); }
      try {
        const profile = validateRuntimeProfile(body, { home: grokHome() });
        const result = await apply(profile);
        if (result.status === "degraded") return Response.json(result, { status: 503 });
        return Response.json({ ...result, profile: result.profile ?? profile });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createRuntimeProfileHandlers();
export const GET = handlers.GET;
export const PUT = handlers.PUT;
