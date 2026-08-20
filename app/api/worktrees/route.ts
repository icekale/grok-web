import { existsSync } from "fs";
import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { canonicalizePath } from "@/lib/git-http";
import { findCurrentWorktreePath, listWorktrees, removeWorktree, resolveProject } from "@/lib/worktree";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import {
  createWorkspaceWorktree,
  refuseWorktreeWrite,
} from "@/lib/grok-fs/workspace.ts";

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be inspected or mutated through this endpoint. */
async function checkCwdAllowed(cwd: string): Promise<Response | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

// GET /api/worktrees?cwd=  →  { projectRoot, isGit, isTopLevel, currentWorktreePath, worktrees }
export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (!cwd) {
      return Response.json({ error: "cwd is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(cwd);
    if (denied) return denied;

    const project = await resolveProject(cwd);
    let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
    let currentWorktreePath: string | null = null;
    let isGit = true;
    try {
      // For a removed-worktree cwd (session of a deleted worktree), fall back
      // to the inferred project root so the switcher still shows the project.
      worktrees = await listWorktrees(existsSync(cwd) ? cwd : project.projectRoot);
      currentWorktreePath = findCurrentWorktreePath(worktrees, cwd);
    } catch {
      isGit = false;
    }
    // Every listed path is a git-verified worktree of this project; allow the
    // file explorer to browse them even before they have any session (the
    // in-memory allowlist from addWorktree does not survive server restarts).
    for (const w of worktrees) allowFileRoot(w.path);
    return Response.json({
      projectRoot: project.projectRoot,
      isGit,
      isTopLevel: project.isTopLevel,
      currentWorktreePath,
      worktrees,
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/worktrees  body: { cwd, branch }  →  { path, branch }
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; branch?: string; sessionId?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return Response.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.branch || typeof body.branch !== "string") {
      return Response.json({ error: "branch is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;
    if (!existsSync(body.cwd)) {
      return Response.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }

    let runtime: ReturnType<typeof getAgentRuntime>;
    try {
      runtime = getAgentRuntime();
      await runtime.ensureProcess();
    } catch {
      refuseWorktreeWrite();
    }
    if (typeof body.sessionId === "string") {
      const result = await createWorkspaceWorktree(body.cwd, body.branch, {
        worktreeCreate: () => runtime.worktreeCreate(body.sessionId as string, body.cwd as string),
      });
      if (result.worktreePath) allowFileRoot(result.worktreePath);
      return Response.json({ path: result.worktreePath, branch: body.branch });
    }
    refuseWorktreeWrite();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("read-only") ? 501 : 400;
    return Response.json({ error: message }, { status });
  }
}

// DELETE /api/worktrees  body: { cwd, path, force? }
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; path?: string; force?: boolean };
    if (!body.cwd || typeof body.cwd !== "string") {
      return Response.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.path || typeof body.path !== "string") {
      return Response.json({ error: "path is required" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    for (const candidate of [body.cwd, body.path]) {
      if (!isFilePathAllowed(candidate, allowedRoots) || !isExistingFilePathAllowed(candidate, allowedRoots)) {
        return Response.json({ error: "Access denied" }, { status: 403 });
      }
    }
    const cwd = canonicalizePath(body.cwd);
    const target = canonicalizePath(body.path);
    for (const canonical of [cwd, target]) {
      if (!isExistingFilePathAllowed(canonical, allowedRoots)) {
        return Response.json({ error: "Access denied" }, { status: 403 });
      }
    }
    await removeWorktree(cwd, target, body.force === true);
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("read-only")) {
      return Response.json({ error: message }, { status: 501 });
    }
    // git refuses to remove dirty worktrees without --force; surface that so
    // the UI can offer a force-remove confirmation.
    const dirty = /contains modified or untracked files|is dirty/i.test(message);
    return Response.json({ error: message, dirty }, { status: dirty ? 409 : 400 });
  }
}
