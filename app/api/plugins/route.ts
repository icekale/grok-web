import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { listMcpServers, readGrokConfig } from "@/lib/grok-settings/home-config.ts";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { grokHome } from "@/lib/grok-home";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginScope,
  PluginsResponse,
} from "@/lib/api-types";

type PluginAction = "remove" | "update" | "disable" | "enable";

type McpServer = {
  name: string;
  source?: string;
  session?: { enabled?: boolean };
};

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function toPackage(server: McpServer): PluginPackageInfo {
  const disabled = server.session?.enabled === false;
  return {
    source: server.name,
    scope: server.source === "project" ? "project" : "global",
    filtered: false,
    disabled,
    packageName: server.name,
    counts: emptyCounts(),
    resources: [],
    status: disabled ? "disabled" : "loaded",
  };
}

function toPluginsResponse(
  servers: McpServer[],
  cwd: string,
  diagnostics: PluginDiagnostic[] = [],
): PluginsResponse {
  return {
    packages: servers.map(toPackage),
    totals: emptyCounts(),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, grokHome()).trusted,
  };
}

async function readPlugins(cwd: string): Promise<PluginsResponse> {
  try {
    const listed = await getAgentRuntime().listMcp();
    return toPluginsResponse(listed.servers ?? [], cwd);
  } catch (error) {
    const diagnostics: PluginDiagnostic[] = [{
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    }];
    const servers = listMcpServers(readGrokConfig()).map((server) => ({
      name: server.name,
      session: server.enabled === false ? { enabled: false } : undefined,
    }));
    return toPluginsResponse(servers, cwd, diagnostics);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return Response.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }
    return Response.json(await readPlugins(cwd));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/plugins body: { action, source?, scope?, cwd }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      action?: PluginAction;
      source?: string;
      scope?: PluginScope;
      cwd?: string;
    };
    if (!body.cwd) return Response.json({ error: "cwd required" }, { status: 400 });
    if (!body.action) return Response.json({ error: "action required" }, { status: 400 });
    if (body.action === "install" || body.scope !== undefined) {
      return Response.json({ error: "Plugin install and scope are not supported" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const source = body.source?.trim();
    const runtime = getAgentRuntime();

    if (body.action === "update") {
      return Response.json({ error: "MCP update is not supported" }, { status: 400 });
    }
    if (body.action === "enable" || body.action === "disable") {
      if (!source) return Response.json({ error: "source required" }, { status: 400 });
      await runtime.toggleMcp(body.cwd, source, body.action === "enable");
    } else if (body.action === "remove") {
      if (!source) return Response.json({ error: "source required" }, { status: 400 });
      await runtime.deleteMcp(body.cwd, source);
    } else {
      return Response.json({ error: `Unsupported action: ${body.action}` }, { status: 400 });
    }

    return Response.json(await readPlugins(body.cwd));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
