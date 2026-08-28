import { peekAgentRuntime } from "@/lib/acp/runtime.ts";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { readFolderTrustEnabled, trustFolder, untrustFolder } from "@/lib/folder-trust";
import { runGrokInspect, type GrokInspectSnapshot } from "@/lib/grok-inspect";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { addUserHook, removeUserHook } from "@/lib/user-hooks";

async function recycleIfPresent(): Promise<void> {
  const runtime = peekAgentRuntime();
  if (runtime) await runtime.recycleProcessAndReload();
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

async function inspectPayload(cwd: string): Promise<GrokInspectSnapshot & { folderTrustEnabled: boolean }> {
  const inspect = await runGrokInspect(cwd);
  return {
    ...inspect,
    folderTrustEnabled: inspect.folderTrustEnabled ?? readFolderTrustEnabled(),
  };
}

function statusOf(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("grok-missing:")) return 503;
  return 500;
}

export async function GET(req: Request): Promise<Response> {
  const cwd = new URL(req.url).searchParams.get("cwd");
  try {
    const allowed = await requireCwd(cwd);
    return Response.json(await inspectPayload(allowed));
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
      event?: string;
      type?: "command" | "http";
      command?: string;
      url?: string;
      matcher?: string;
      timeout?: number;
      target?: string;
    };
    const cwd = await requireCwd(body.cwd);
    if (body.action === "add") {
      const target = addUserHook({
        event: body.event ?? "",
        type: body.type === "http" ? "http" : "command",
        command: body.command,
        url: body.url,
        matcher: body.matcher,
        timeout: body.timeout,
      });
      await recycleIfPresent();
      return Response.json({ ok: true, target, ...(await inspectPayload(cwd)) });
    }
    if (body.action === "remove") {
      if (!body.target) return Response.json({ error: "target required" }, { status: 400 });
      removeUserHook(body.target);
      await recycleIfPresent();
      return Response.json({ ok: true, ...(await inspectPayload(cwd)) });
    }
    if (body.action === "trust" || body.action === "untrust") {
      const current = await runGrokInspect(cwd);
      const root = current.projectRoot || cwd;
      if (body.action === "trust") trustFolder(root);
      else untrustFolder(root);
      await recycleIfPresent();
      return Response.json({ ok: true, ...(await inspectPayload(cwd)) });
    }
    if (body.action === "reload") {
      await recycleIfPresent();
      return Response.json({ ok: true, ...(await inspectPayload(cwd)) });
    }
    return Response.json({ error: "action required" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: statusOf(error) });
  }
}
