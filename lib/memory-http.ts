import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { peekAgentRuntime } from "@/lib/acp/runtime.ts";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { grokHome } from "@/lib/grok-home";
import { appendRememberNote, assertSessionLogPath, pinGrokMemoryEnabled, readMemoryEnabled, workspaceMemoryDir } from "@/lib/memory-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export type MemoryFile = {
  scope: "global" | "workspace" | "session";
  path: string;
  name: string;
  mtime: number;
};

function envMemoryOverride(): boolean | null {
  const raw = process.env.GROK_MEMORY?.trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function listMemoryFiles(home: string, cwd: string): MemoryFile[] {
  const root = join(home, "memory");
  if (!existsSync(root)) return [];
  const files: MemoryFile[] = [];
  const globalFile = join(root, "MEMORY.md");
  if (existsSync(globalFile)) {
    files.push({ scope: "global", path: globalFile, name: "MEMORY.md", mtime: statSync(globalFile).mtimeMs });
  }
  const workspaceDir = workspaceMemoryDir(cwd, home);
  const workspaceName = basename(workspaceDir);
  const workspace = join(workspaceDir, "MEMORY.md");
  if (existsSync(workspace)) {
    files.push({
      scope: "workspace",
      path: workspace,
      name: `${workspaceName}/MEMORY.md`,
      mtime: statSync(workspace).mtimeMs,
    });
  }
  const sessions = join(workspaceDir, "sessions");
  if (existsSync(sessions)) {
    for (const log of readdirSync(sessions, { withFileTypes: true })) {
      if (!log.isFile()) continue;
      const path = join(sessions, log.name);
      files.push({
        scope: "session",
        path,
        name: `${workspaceName}/sessions/${log.name}`,
        mtime: statSync(path).mtimeMs,
      });
    }
  }
  return files.sort((left, right) => right.mtime - left.mtime);
}

function snapshot(home = grokHome(), cwd: string, previewPath?: string) {
  const config = existsSync(join(home, "config.toml")) ? readFileSync(join(home, "config.toml"), "utf8") : "";
  const env = envMemoryOverride();
  const enabled = env ?? readMemoryEnabled(config);
  const files = enabled ? listMemoryFiles(home, cwd) : [];
  const previewFile = previewPath && files.some((file) => file.path === previewPath)
    ? previewPath
    : files[0]?.path;
  return {
    enabled,
    envOverrides: env !== null,
    files,
    preview: previewFile && existsSync(previewFile) ? { path: previewFile, text: readFileSync(previewFile, "utf8") } : null,
  };
}

async function requireCwd(cwd: string | null | undefined): Promise<string> {
  if (!cwd) {
    const error = new Error("cwd required");
    (error as Error & { status: number }).status = 400;
    throw error;
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    const error = new Error("Access denied");
    (error as Error & { status: number }).status = 403;
    throw error;
  }
  return cwd;
}

function statusOf(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return 500;
}

async function recycleIfPresent(): Promise<void> {
  const runtime = peekAgentRuntime();
  if (runtime) await runtime.recycleProcessAndReload();
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const cwd = await requireCwd(url.searchParams.get("cwd"));
    return Response.json(snapshot(grokHome(), cwd, url.searchParams.get("preview") || undefined));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: statusOf(error) });
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as {
      action?: string;
      cwd?: string;
      text?: string;
      scope?: "workspace" | "global";
      path?: string;
    };
    const cwd = await requireCwd(body.cwd);
    const home = grokHome();
    if (body.action === "enable" || body.action === "disable") {
      pinGrokMemoryEnabled(body.action === "enable", home);
      await recycleIfPresent();
      return Response.json({ ok: true, ...snapshot(home, cwd) });
    }
    if (body.action === "remember") {
      const file = body.scope === "global"
        ? join(home, "memory", "MEMORY.md")
        : join(workspaceMemoryDir(cwd, home), "MEMORY.md");
      appendRememberNote(file, body.text ?? "");
      return Response.json({ ok: true, ...snapshot(home, cwd, file) });
    }
    if (body.action === "delete") {
      if (!body.path) return Response.json({ error: "path required" }, { status: 400 });
      unlinkSync(assertSessionLogPath(body.path, home));
      return Response.json({ ok: true, ...snapshot(home, cwd) });
    }
    return Response.json({ error: "action required" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: statusOf(error) });
  }
}
