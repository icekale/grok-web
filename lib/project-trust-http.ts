import { realpath, stat } from "fs/promises";
import { resolve } from "path";
import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { grokHome } from "@/lib/grok-home";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getProjectTrustStatus, trustProject } from "@/lib/project-trust";

async function validateCwd(value: unknown): Promise<
  { cwd: string } | { response: Response }
> {
  if (typeof value !== "string" || !value.trim()) {
    return { response: Response.json({ error: "cwd required" }, { status: 400 }) };
  }

  let cwd: string;
  try {
    cwd = await realpath(resolve(value));
    if (!(await stat(cwd)).isDirectory()) {
      return { response: Response.json({ error: "cwd must be a directory" }, { status: 400 }) };
    }
  } catch {
    return { response: Response.json({ error: "Directory does not exist" }, { status: 400 }) };
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: Response.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

export async function GET(req: Request) {
  const result = await validateCwd(new URL(req.url).searchParams.get("cwd"));
  if ("response" in result) return result.response;
  return Response.json(getProjectTrustStatus(result.cwd, grokHome()));
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const result = await validateCwd(body.cwd);
    if ("response" in result) return result.response;

    const agentDir = grokHome();
    const current = getProjectTrustStatus(result.cwd, agentDir);
    if (!current.requiresTrust) {
      return Response.json({ error: "This project has no resources that require trust" }, { status: 409 });
    }
    if (getAgentRuntime().hasBusySessionForCwd(result.cwd)) {
      return Response.json({ error: "Wait for the active session to finish before trusting this project" }, { status: 409 });
    }

    const status = trustProject(result.cwd, agentDir);
    invalidateModelsCache();
    await getAgentRuntime().dropSessionsForCwd(result.cwd);
    return Response.json(status);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
