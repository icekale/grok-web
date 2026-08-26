import fs from "node:fs";
import path from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { commitGitChanges, discardGitFiles, stageGitFiles } from "@/lib/git-changes";

function isAbs(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

export async function resolveGitCwd(cwd: string): Promise<
  | { cwd: string; allowedRoots: Set<string> }
  | { error: string; status: number }
> {
  if (!cwd || !isAbs(cwd)) {
    return { error: "cwd must be an absolute path", status: 400 };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: "Access denied", status: 403 };
  }
  const canonicalCwd = canonicalizePath(cwd);
  if (!isExistingFilePathAllowed(canonicalCwd, allowedRoots)) {
    return { error: "Access denied", status: 403 };
  }
  if (!fs.statSync(canonicalCwd).isDirectory()) {
    return { error: "Not a directory", status: 400 };
  }
  return { cwd: canonicalCwd, allowedRoots };
}

export function canonicalizePath(filePath: string): string {
  let existing = path.resolve(filePath);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(existing), ...suffix.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(filePath);
      suffix.push(path.basename(existing));
      existing = parent;
    }
  }
}

export function isPathInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveAuthorizedGitFilePath(
  canonicalCwd: string,
  requestedPath: string,
  allowedRoots: Set<string>,
): { filePath: string; relativePath: string } | { error: string; status: number } {
  if (!isFilePathAllowed(requestedPath, allowedRoots)) {
    return { error: "Access denied", status: 403 };
  }
  const canonicalParent = canonicalizePath(path.dirname(requestedPath));
  if (
    !isExistingFilePathAllowed(canonicalParent, allowedRoots)
    || !fs.statSync(canonicalParent).isDirectory()
  ) {
    return { error: "Access denied", status: 403 };
  }
  const filePath = path.join(canonicalParent, path.basename(requestedPath));
  if (!isPathInside(canonicalCwd, filePath)) {
    return { error: "path must be inside cwd", status: 400 };
  }
  const relativePath = path.relative(canonicalCwd, filePath).split(path.sep).join("/");
  if (!relativePath) {
    return { error: "path must be inside cwd", status: 400 };
  }
  return { filePath, relativePath };
}

export async function handleGitWrite(
  req: Request,
  action: "stage" | "discard" | "commit",
): Promise<Response> {
  try {
    const body = await req.json() as { cwd?: unknown; path?: unknown; message?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const resolvedCwd = await resolveGitCwd(cwd);
    if ("error" in resolvedCwd) {
      return Response.json({ error: resolvedCwd.error }, { status: resolvedCwd.status });
    }

    if (action === "commit") {
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return Response.json({ error: "message is required" }, { status: 400 });
      const data = await commitGitChanges(resolvedCwd.cwd, message);
      return Response.json({ success: true, data });
    }

    const filePath = typeof body.path === "string" ? body.path.trim() : "";
    if (!filePath || !isAbs(filePath)) {
      return Response.json({ error: "path must be an absolute path" }, { status: 400 });
    }
    const resolved = resolveAuthorizedGitFilePath(resolvedCwd.cwd, filePath, resolvedCwd.allowedRoots);
    if ("error" in resolved) {
      return Response.json({ error: resolved.error }, { status: resolved.status });
    }

    const data = action === "stage"
      ? await stageGitFiles(resolvedCwd.cwd, [resolved.relativePath])
      : await discardGitFiles(resolvedCwd.cwd, [resolved.relativePath]);
    return Response.json({ success: true, data });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
