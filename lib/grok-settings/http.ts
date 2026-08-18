import { grokHome } from "../grok-home.ts";
import { loadGrokSettings, writeGrokWebSettings } from "./home-config.ts";

export function getGrokSettings(home = grokHome(), cwd?: string): Response {
  return Response.json(loadGrokSettings(home, cwd));
}

export async function putGrokSettings(req: Request, home = grokHome()): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Settings object is required" }, { status: 400 });
  }
  writeGrokWebSettings(body, home);
  return Response.json(loadGrokSettings(home));
}
