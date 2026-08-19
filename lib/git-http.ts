import path from "node:path";
import { getAgentRuntime } from "@/lib/acp/runtime";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";

const ACP_MISSING = "Grok agent is not available";

function isAbs(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

export async function handleGitWrite(
  req: Request,
  action: "stage" | "discard" | "commit",
): Promise<Response> {
  try {
    const body = await req.json() as { cwd?: unknown; path?: unknown; message?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd || !isAbs(cwd)) {
      return Response.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    let runtime;
    try {
      runtime = getAgentRuntime();
      await runtime.ensureProcess();
    } catch {
      return Response.json({ error: ACP_MISSING }, { status: 501 });
    }

    if (action === "commit") {
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return Response.json({ error: "message is required" }, { status: 400 });
      const data = await runtime.gitCommit(message);
      return Response.json({ success: true, data });
    }

    const filePath = typeof body.path === "string" ? body.path.trim() : "";
    if (!filePath || !isAbs(filePath)) {
      return Response.json({ error: "path must be an absolute path" }, { status: 400 });
    }
    if (!isFilePathAllowed(filePath, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }
    const relativePath = path.relative(cwd, filePath).split(path.sep).join("/");
    if (!relativePath || relativePath.startsWith("..")) {
      return Response.json({ error: "path must be inside cwd" }, { status: 400 });
    }

    const data = action === "stage"
      ? await runtime.gitStage([relativePath])
      : await runtime.gitDiscard([relativePath]);
    return Response.json({ success: true, data });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
