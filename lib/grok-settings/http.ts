import { grokHome } from "../grok-home.ts";
import {
  loadGrokSettings,
  writeGrokWebSettings,
  writePermissionMode,
} from "./home-config.ts";

function publicSettings(home = grokHome(), cwd?: string) {
  const settings = loadGrokSettings(home, cwd);
  return {
    username: settings.username,
    web: settings.web,
    auth: settings.auth,
    mcpServers: settings.mcpServers,
    skills: settings.skills,
    permissionMode: settings.permissionMode,
  };
}

export function getGrokSettings(home = grokHome(), cwd?: string): Response {
  return Response.json(publicSettings(home, cwd));
}

export async function putGrokSettings(req: Request, home = grokHome()): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Settings object is required" }, { status: 400 });
  }
  const { permissionMode, ...web } = body;
  if (permissionMode !== undefined) {
    if (permissionMode !== "ask" && permissionMode !== "auto" && permissionMode !== "always-approve") {
      return Response.json({ error: "permissionMode must be ask, auto, or always-approve" }, { status: 400 });
    }
    writePermissionMode(permissionMode, home);
  }
  if (Object.keys(web).length > 0) writeGrokWebSettings(web, home);
  return Response.json(publicSettings(home));
}
