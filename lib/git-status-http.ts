import { getGitStatus } from "@/lib/git-changes";
import { resolveGitCwd } from "@/lib/git-http";

export async function GET(request: Request) {
  try {
    const cwd = new URL(request.url).searchParams.get("cwd")?.trim() ?? "";
    const resolved = await resolveGitCwd(cwd);
    if ("error" in resolved) {
      return Response.json({ error: resolved.error }, { status: resolved.status });
    }
    return Response.json(await getGitStatus(resolved.cwd));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
