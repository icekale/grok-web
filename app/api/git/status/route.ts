import fs from "fs";
import path from "path";
import { getAgentRuntime } from "@/lib/acp/runtime";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitStatus } from "@/lib/git-changes";
import type { GitFileStatus, GitStatusResponse } from "@/lib/git-types";

export async function GET(request: Request) {
  try {
    const cwd = new URL(request.url).searchParams.get("cwd")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return Response.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return Response.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return Response.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    try {
      const runtime = getAgentRuntime();
      await runtime.ensureProcess();
      const raw = await runtime.gitStatus();
      if (looksLikeGitRepo(raw)) {
        const mapped = mapAcpGitStatus(raw, cwd);
        return Response.json(mapped ?? raw);
      }
    } catch {
      // ACP unavailable or git/status unsupported; use local git.
    }
    return Response.json(await getGitStatus(cwd));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function looksLikeGitRepo(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (raw.isGitRepository === false) return false;
  if (raw.isGitRepository === true) return true;
  if (typeof raw.branch === "string") return true;
  if (typeof raw.root === "string" || typeof raw.repositoryRoot === "string") return true;
  return Array.isArray(raw.files) || Array.isArray(raw.unstaged) || Array.isArray(raw.staged);
}

function cwdMatchesRoot(cwd: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mapGitFiles(entries: unknown, indexStatus: string, worktreeStatus: string): GitFileStatus[] {
  if (!Array.isArray(entries)) return [];
  const files: GitFileStatus[] = [];
  for (const entry of entries) {
    const filePath = typeof entry === "string"
      ? entry
      : isRecord(entry) && typeof entry.path === "string"
        ? entry.path
        : isRecord(entry) && typeof entry.filePath === "string"
          ? entry.filePath
          : null;
    if (!filePath) continue;
    const status = isRecord(entry) && typeof entry.status === "string" ? entry.status : "modified";
    const kind = status === "added" || status === "deleted" || status === "renamed"
      || status === "untracked" || status === "conflict" || status === "modified"
      ? status
      : "modified";
    const code = kind === "added" ? "A"
      : kind === "deleted" ? "D"
        : kind === "renamed" ? "R"
          : kind === "untracked" ? "U"
            : kind === "conflict" ? "C"
              : "M";
    files.push({
      filePath,
      status: kind,
      code,
      indexStatus,
      worktreeStatus,
    });
  }
  return files;
}

function mapAcpGitStatus(raw: unknown, cwd: string): GitStatusResponse | null {
  if (!isRecord(raw)) return null;
  const root = typeof raw.repositoryRoot === "string"
    ? raw.repositoryRoot
    : typeof raw.root === "string"
      ? raw.root
      : null;
  if (root && !cwdMatchesRoot(cwd, root)) return null;
  if (typeof raw.isGitRepository === "boolean" && Array.isArray(raw.files)) {
    return {
      isGitRepository: raw.isGitRepository,
      repositoryRoot: root,
      files: raw.files as GitFileStatus[],
      additions: typeof raw.additions === "number" ? raw.additions : 0,
      deletions: typeof raw.deletions === "number" ? raw.deletions : 0,
    };
  }
  return {
    isGitRepository: true,
    repositoryRoot: root,
    files: [
      ...mapGitFiles(raw.staged, "M", " "),
      ...mapGitFiles(raw.unstaged, " ", "M"),
    ],
    additions: typeof raw.additions === "number" ? raw.additions : 0,
    deletions: typeof raw.deletions === "number" ? raw.deletions : 0,
  };
}
