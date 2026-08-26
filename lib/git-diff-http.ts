import { isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { resolveAuthorizedGitFilePath, resolveGitCwd } from "@/lib/git-http";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const cwd = url.searchParams.get("cwd")?.trim() ?? "";
    const filePath = url.searchParams.get("path")?.trim() ?? "";
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return Response.json({ error: "path must be an absolute path" }, { status: 400 });
    }
    const resolvedCwd = await resolveGitCwd(cwd);
    if ("error" in resolvedCwd) {
      return Response.json({ error: resolvedCwd.error }, { status: resolvedCwd.status });
    }
    const resolved = resolveAuthorizedGitFilePath(resolvedCwd.cwd, filePath, resolvedCwd.allowedRoots);
    if ("error" in resolved) {
      return Response.json({ error: resolved.error }, { status: resolved.status });
    }
    return Response.json(await getGitFileDiff(resolvedCwd.cwd, resolved.filePath));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
