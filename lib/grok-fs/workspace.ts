import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const WORKSPACE_WRITE_ERROR =
  "Local fallback is read-only; ACP filesystem write is not available";

export const WORKTREE_WRITE_ERROR =
  "Local fallback is read-only; ACP worktree write is not available";

function assertInsideRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(target);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes workspace root");
  }
  return resolved;
}

export function listWorkspaceEntries(root: string, relPath = ""): Array<{
  name: string;
  path: string;
  isDirectory: boolean;
}> {
  const dir = assertInsideRoot(root, join(root, relPath));
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    path: join(dir, entry.name),
    isDirectory: entry.isDirectory(),
  }));
}

export function readWorkspaceFile(root: string, relPath: string): string {
  const file = assertInsideRoot(root, join(root, relPath));
  if (!statSync(file).isFile()) throw new Error("Not a file");
  return readFileSync(file, "utf8");
}

export function refuseWorkspaceWrite(): never {
  throw new Error(WORKSPACE_WRITE_ERROR);
}

export type WorkspaceWriter = {
  write: (absPath: string, content: string) => Promise<void>;
};

export async function writeWorkspaceFile(
  root: string,
  relPath: string,
  content: string,
  io?: WorkspaceWriter,
): Promise<boolean> {
  const abs = assertInsideRoot(root, join(root, relPath));
  if (!io) refuseWorkspaceWrite();
  await io.write(abs, content);
  return true;
}

export type WorkspaceGitStatus = {
  isGitRepository: boolean;
  branch: string | null;
  porcelain: string;
} & Record<string, unknown>;

export type WorkspaceGitIo = {
  gitStatus: () => Promise<unknown>;
};

export async function readWorkspaceGitStatus(
  cwd: string,
  io?: WorkspaceGitIo,
): Promise<WorkspaceGitStatus> {
  if (io?.gitStatus) {
    const raw = await io.gitStatus();
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const branch = typeof record.branch === "string" || record.branch === null
      ? (record.branch as string | null)
      : null;
    return {
      ...record,
      branch,
      isGitRepository: record.isGitRepository === false ? false : Boolean(record.isGitRepository ?? true),
      porcelain: typeof record.porcelain === "string" ? record.porcelain : "",
    };
  }
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const porcelain = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
      encoding: "utf8",
    });
    return { isGitRepository: true, branch, porcelain };
  } catch {
    return { isGitRepository: false, branch: null, porcelain: "" };
  }
}

export function listWorkspaceWorktrees(cwd: string): Array<{ path: string; isMain: boolean }> {
  try {
    const out = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    const trees: Array<{ path: string; isMain: boolean }> = [];
    for (const line of out.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length).trim();
      if (path && existsSync(path)) trees.push({ path, isMain: trees.length === 0 });
    }
    return trees;
  } catch {
    return [];
  }
}

export function refuseWorktreeWrite(): never {
  throw new Error(WORKTREE_WRITE_ERROR);
}

export type WorkspaceWorktreeCreateIo = {
  worktreeCreate: (cwd: string, branch: string) => Promise<{ worktreePath?: string; status?: string }>;
};

export type WorkspaceWorktreeRemoveIo = {
  worktreeRemove: (worktreePath: string) => Promise<unknown>;
};

export async function createWorkspaceWorktree(
  cwd: string,
  branch: string,
  io?: WorkspaceWorktreeCreateIo,
): Promise<{ worktreePath?: string; status?: string }> {
  if (!io?.worktreeCreate) refuseWorktreeWrite();
  return await io.worktreeCreate(cwd, branch);
}

export async function removeWorkspaceWorktree(
  worktreePath: string,
  io?: WorkspaceWorktreeRemoveIo,
): Promise<unknown> {
  if (!io?.worktreeRemove) refuseWorktreeWrite();
  return await io.worktreeRemove(worktreePath);
}
