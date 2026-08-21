import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import type { GrokPluginInfo } from "@/lib/acp/connection.ts";
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

type PluginAction = "remove" | "update" | "disable" | "enable" | "add";

const MCP_NAME = /^[A-Za-z0-9_-]+$/;

type McpServer = {
  name: string;
  source?: string;
  pluginName?: string;
  command?: string;
  url?: string;
  session?: { enabled?: boolean };
};

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0, agents: 0, hooks: 0, mcpServers: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toPackage(server: McpServer): PluginPackageInfo {
  const disabled = server.session?.enabled === false;
  const plugin = Boolean(server.pluginName);
  return {
    source: server.name,
    scope: server.source === "project" ? "project" : "global",
    filtered: false,
    disabled,
    packageName: server.name,
    installedPath: server.command || server.url,
    origin: plugin ? "plugin" : "config",
    pluginName: server.pluginName,
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
    marketplace: { sources: [] },
  };
}

function expandPluginRoot(value: string, root: string): string {
  return value.replaceAll("${GROK_PLUGIN_ROOT}", root);
}

function serversFromPlugin(plugin: GrokPluginInfo): McpServer[] {
  if (plugin.enabled === false) return [];
  const root = plugin.root;
  if (!root) return [];
  const file = join(root, ".mcp.json");
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const table = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  const enabled = plugin.enabled !== false;
  const servers: McpServer[] = [];
  for (const [name, spec] of Object.entries(table)) {
    if (!name || !isRecord(spec)) continue;
    const command = typeof spec.command === "string" ? expandPluginRoot(spec.command, root) : undefined;
    const url = typeof spec.url === "string" ? spec.url : undefined;
    const args = Array.isArray(spec.args)
      ? spec.args.map((arg) => typeof arg === "string" ? expandPluginRoot(arg, root) : String(arg))
      : [];
    servers.push({
      name,
      pluginName: plugin.name,
      command: command ? [command, ...args].join(" ") : undefined,
      url,
      session: { enabled },
    });
  }
  return servers;
}

async function pluginMcpServers(cwd: string): Promise<{ servers: McpServer[]; error?: string }> {
  try {
    const listed = await getAgentRuntime().listPlugins(cwd);
    return { servers: (listed.plugins ?? []).flatMap(serversFromPlugin) };
  } catch (error) {
    return { servers: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function mergeMcpServers(primary: McpServer[], extra: McpServer[]): McpServer[] {
  const pluginByName = new Map(extra.map((server) => [server.name, server]));
  const merged = primary.map((server) => {
    const plugin = pluginByName.get(server.name);
    return plugin
      ? {
        ...server,
        pluginName: plugin.pluginName,
        command: server.command ?? plugin.command,
        url: server.url ?? plugin.url,
      }
      : server;
  });
  const seen = new Set(merged.map((server) => server.name));
  for (const server of extra) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    merged.push(server);
  }
  return merged;
}

function parseTransport(body: {
  command?: unknown;
  url?: unknown;
  args?: unknown;
}): { command?: string; url?: string; args?: string[] } | { error: string } {
  if (typeof body.url === "string" && body.url.trim()) {
    return { url: body.url.trim() };
  }
  const raw = typeof body.command === "string" ? body.command.trim() : "";
  if (!raw) return { error: "command or url required" };
  if (/^https?:\/\//i.test(raw)) return { url: raw };
  const [command, ...args] = raw.split(/\s+/);
  if (typeof body.args === "object" && Array.isArray(body.args)) {
    return { command, args: body.args.filter((arg): arg is string => typeof arg === "string") };
  }
  return { command, ...(args.length ? { args } : {}) };
}

function pluginOverlayDiagnostic(error: string): PluginDiagnostic {
  return { type: "error", message: `Plugin MCP overlay failed: ${error}` };
}

async function readMcp(cwd: string): Promise<PluginsResponse> {
  const plugin = await pluginMcpServers(cwd);
  const overlayDiagnostics = plugin.error ? [pluginOverlayDiagnostic(plugin.error)] : [];
  try {
    const listed = await getAgentRuntime().listMcp(cwd);
    return toPluginsResponse(
      mergeMcpServers(listed.servers ?? [], plugin.servers),
      cwd,
      overlayDiagnostics.length ? overlayDiagnostics : undefined,
    );
  } catch (error) {
    const diagnostics: PluginDiagnostic[] = [
      ...overlayDiagnostics,
      {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
    const servers = listMcpServers(readGrokConfig()).map((server) => ({
      name: server.name,
      session: server.enabled === false ? { enabled: false } : undefined,
    }));
    return toPluginsResponse(mergeMcpServers(servers, plugin.servers), cwd, diagnostics);
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
    return Response.json(await readMcp(cwd));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      action?: PluginAction | "install";
      source?: string;
      scope?: PluginScope;
      cwd?: string;
      command?: string;
      url?: string;
      args?: string[];
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
    if (body.action === "add") {
      if (!source || !MCP_NAME.test(source)) {
        return Response.json({ error: "MCP name may only contain letters, numbers, hyphens, and underscores" }, { status: 400 });
      }
      const transport = parseTransport(body);
      if ("error" in transport) return Response.json({ error: transport.error }, { status: 400 });
      await runtime.upsertMcp(body.cwd, source, transport);
    } else if (body.action === "enable" || body.action === "disable") {
      if (!source) return Response.json({ error: "source required" }, { status: 400 });
      await runtime.toggleMcp(body.cwd, source, body.action === "enable");
    } else if (body.action === "remove") {
      if (!source) return Response.json({ error: "source required" }, { status: 400 });
      const plugin = await pluginMcpServers(body.cwd);
      if (plugin.error) {
        return Response.json({ error: "Cannot verify MCP origin because plugin list failed." }, { status: 503 });
      }
      if (plugin.servers.some((server) => server.name === source)) {
        return Response.json({ error: "Plugin MCP servers are removed by disabling or uninstalling the plugin." }, { status: 400 });
      }
      await runtime.deleteMcp(body.cwd, source);
    } else {
      return Response.json({ error: `Unsupported action: ${body.action}` }, { status: 400 });
    }

    return Response.json(await readMcp(body.cwd));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
