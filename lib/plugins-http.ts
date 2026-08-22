import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import type {
  GrokActionOutcome,
  GrokMarketplaceAction,
  GrokMarketplaceSource,
  GrokPluginInfo,
  GrokPluginsAction,
} from "@/lib/acp/connection.ts";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { grokHome } from "@/lib/grok-home";
import type {
  MarketplaceSourceInfo,
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginsResponse,
} from "@/lib/api-types";

type PluginHttpAction =
  | "remove"
  | "update"
  | "disable"
  | "enable"
  | "install"
  | "add"
  | "reload"
  | "add_source"
  | "remove_source"
  | "refresh"
  | "marketplace_install"
  | "marketplace_uninstall"
  | "marketplace_update";

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0, agents: 0, hooks: 0, mcpServers: 0 };
}

function pluginResources(plugin: GrokPluginInfo): PluginResourceInfo[] {
  const root = plugin.root ?? "";
  const skills = (plugin.skillNames ?? []).map((name) => ({
    kind: "skill" as const,
    name,
    path: root,
    relativePath: `skills/${name}`,
  }));
  const agents = (plugin.agentNames ?? []).map((name) => ({
    kind: "agent" as const,
    name,
    path: root,
    relativePath: `agents/${name}`,
  }));
  return [...skills, ...agents];
}

function toPackage(plugin: GrokPluginInfo): PluginPackageInfo {
  const disabled = plugin.enabled === false;
  const counts = emptyCounts();
  counts.skills = plugin.skillCount ?? plugin.skillNames?.length ?? 0;
  counts.agents = plugin.agentCount ?? plugin.agentNames?.length ?? 0;
  counts.hooks = plugin.hookCount ?? 0;
  counts.mcpServers = plugin.mcpServerCount ?? 0;
  return {
    source: plugin.name,
    scope: plugin.scope === "project" ? "project" : "global",
    filtered: false,
    disabled,
    installedPath: plugin.root,
    packageName: plugin.name,
    version: plugin.version,
    description: plugin.description,
    trusted: plugin.trusted,
    counts,
    resources: pluginResources(plugin),
    status: disabled ? "disabled" : "loaded",
  };
}

function toMarketplace(sources: GrokMarketplaceSource[]): MarketplaceSourceInfo[] {
  return sources.map((source) => ({
    sourceName: source.sourceName,
    sourceKind: source.sourceKind,
    sourceUrlOrPath: source.sourceUrlOrPath,
    error: source.error ?? null,
    plugins: (source.plugins ?? []).map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      relativePath: plugin.relativePath ?? plugin.name,
      skillCount: plugin.skillCount,
      hasHooks: plugin.hasHooks,
      hasAgents: plugin.hasAgents,
      hasMcp: plugin.hasMcp,
      installStatus: plugin.installStatus,
      installedVersion: plugin.installedVersion,
    })),
  }));
}

function totalsFrom(packages: PluginPackageInfo[]): PluginResourceCounts {
  const totals = emptyCounts();
  for (const pkg of packages) {
    totals.skills += pkg.counts.skills;
    totals.agents += pkg.counts.agents;
    totals.hooks += pkg.counts.hooks;
    totals.mcpServers += pkg.counts.mcpServers;
    totals.extensions += pkg.counts.extensions;
    totals.prompts += pkg.counts.prompts;
    totals.themes += pkg.counts.themes;
  }
  return totals;
}

function toPluginsResponse(
  plugins: GrokPluginInfo[],
  sources: GrokMarketplaceSource[],
  cwd: string,
  diagnostics: PluginDiagnostic[] = [],
): PluginsResponse {
  const packages = plugins.map(toPackage);
  return {
    packages,
    totals: totalsFrom(packages),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, grokHome()).trusted,
    marketplace: { sources: toMarketplace(sources) },
  };
}

function marketplaceInstalledNames(sources: GrokMarketplaceSource[]): string[] {
  const names: string[] = [];
  for (const source of sources) {
    for (const plugin of source.plugins ?? []) {
      if (plugin.installStatus === "installed" && plugin.name) names.push(plugin.name);
    }
  }
  return names;
}

async function readPlugins(cwd: string, refreshed = false): Promise<PluginsResponse> {
  const diagnostics: PluginDiagnostic[] = [];
  let plugins: GrokPluginInfo[] = [];
  let sources: GrokMarketplaceSource[] = [];
  const runtime = getAgentRuntime();
  try {
    const listed = await runtime.listPlugins(cwd);
    plugins = listed.plugins ?? [];
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const listed = await runtime.listMarketplace(cwd);
    sources = listed.sources ?? [];
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const listedNames = new Set(plugins.map((plugin) => plugin.name));
  const stale = !refreshed
    && diagnostics.length === 0
    && marketplaceInstalledNames(sources).some((name) => !listedNames.has(name));
  if (stale) {
    try {
      await runtime.pluginsAction(cwd, { type: "reload" });
      return readPlugins(cwd, true);
    } catch {
      // Keep the first listing if the agent cannot rebuild the plugin registry.
    }
  }
  return toPluginsResponse(plugins, sources, cwd, diagnostics);
}

function requireOutcome(outcome: GrokActionOutcome): void {
  if (outcome.status && outcome.status !== "success") {
    throw new Error(outcome.message || outcome.status);
  }
}

function pluginActionFromBody(body: {
  action: PluginHttpAction;
  source?: string;
  path?: string;
}): GrokPluginsAction | null {
  const source = body.source?.trim();
  switch (body.action) {
    case "enable":
    case "disable":
      if (!source) throw new Error("source required");
      return { type: body.action, plugin_id: source };
    case "remove":
      if (!source) throw new Error("source required");
      return { type: "uninstall", plugin_id: source };
    case "update":
      return { type: "update" };
    case "install":
      if (!source) throw new Error("source required");
      return { type: "install", source };
    case "add":
      if (!body.path?.trim() && !source) throw new Error("path required");
      return { type: "add", path: (body.path ?? source)!.trim() };
    case "reload":
      return { type: "reload" };
    default:
      return null;
  }
}

function marketplaceActionFromBody(body: {
  action: PluginHttpAction;
  url?: string;
  source?: string;
  source_url_or_path?: string;
  plugin_relative_path?: string;
}): GrokMarketplaceAction | null {
  const sourceUrl = body.source_url_or_path?.trim() || body.source?.trim();
  switch (body.action) {
    case "add_source":
      if (!body.url?.trim()) throw new Error("url required");
      return { type: "add_source", url: body.url.trim() };
    case "remove_source":
      if (!sourceUrl) throw new Error("source_url_or_path required");
      return { type: "remove_source", source_url_or_path: sourceUrl };
    case "refresh":
      return { type: "refresh" };
    case "marketplace_install":
      if (!sourceUrl) throw new Error("source_url_or_path required");
      if (!body.plugin_relative_path?.trim()) throw new Error("plugin_relative_path required");
      return {
        type: "install",
        source_url_or_path: sourceUrl,
        plugin_relative_path: body.plugin_relative_path.trim(),
      };
    case "marketplace_uninstall":
      if (!sourceUrl) throw new Error("source_url_or_path required");
      return {
        type: "uninstall",
        source_url_or_path: sourceUrl,
        ...(body.plugin_relative_path?.trim()
          ? { plugin_relative_path: body.plugin_relative_path.trim() }
          : {}),
      };
    case "marketplace_update":
      if (!sourceUrl) throw new Error("source_url_or_path required");
      return { type: "update", source_url_or_path: sourceUrl };
    default:
      return null;
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

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      action?: PluginHttpAction;
      source?: string;
      path?: string;
      url?: string;
      source_url_or_path?: string;
      plugin_relative_path?: string;
      cwd?: string;
    };
    if (!body.cwd) return Response.json({ error: "cwd required" }, { status: 400 });
    if (!body.action) return Response.json({ error: "action required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    const runtime = getAgentRuntime();
    try {
      const pluginAction = pluginActionFromBody(body as { action: PluginHttpAction; source?: string; path?: string });
      if (pluginAction) {
        requireOutcome(await runtime.pluginsAction(body.cwd, pluginAction));
      } else {
        const marketAction = marketplaceActionFromBody(body as {
          action: PluginHttpAction;
          url?: string;
          source?: string;
          source_url_or_path?: string;
          plugin_relative_path?: string;
        });
        if (!marketAction) {
          return Response.json({ error: `Unsupported action: ${body.action}` }, { status: 400 });
        }
        requireOutcome(await runtime.marketplaceAction(body.cwd, marketAction));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.endsWith(" required")) {
        return Response.json({ error: message }, { status: 400 });
      }
      throw error;
    }

    return Response.json(await readPlugins(body.cwd));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
