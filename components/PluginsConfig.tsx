"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { sendAgentCommand } from "@/lib/agent-client";
import { useIsMobile } from "@/hooks/useIsMobile";
import type {
  MarketplacePluginInfo,
  MarketplaceSourceInfo,
  PluginPackageInfo,
  PluginsResponse,
} from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { PluginsNavigator } from "./resource-settings/PluginsNavigator";
import type { SettingsSectionController } from "./resource-settings/resource-settings-types";
import {
  filterPluginsNavigation,
  pluginIdentity,
  pluginsSelectionLabel,
  resolvePluginsSelection,
} from "./resource-settings/plugins-navigation";

type PluginScope = PluginPackageInfo["scope"];
type PluginAction = "remove" | "update" | "disable" | "enable";
type PluginsView = "plugins" | "marketplace";
type PluginsVariant = "plugins" | "mcp";

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function resourceSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  if (pkg.disabled) return t("i18n.disabled");
  const parts = [
    pkg.counts.skills ? t("i18n.resourceCount", { count: pkg.counts.skills, label: t("i18n.skillShort") }) : "",
    pkg.counts.agents ? t("i18n.resourceCount", { count: pkg.counts.agents, label: t("i18n.agentShort") }) : "",
    pkg.counts.hooks ? t("i18n.resourceCount", { count: pkg.counts.hooks, label: t("i18n.hookShort") }) : "",
    pkg.counts.mcpServers ? t("i18n.resourceCount", { count: pkg.counts.mcpServers, label: t("i18n.mcpShort") }) : "",
    pkg.counts.extensions ? t("i18n.resourceCount", { count: pkg.counts.extensions, label: t("i18n.extensionShort") }) : "",
    pkg.counts.prompts ? t("i18n.resourceCount", { count: pkg.counts.prompts, label: t("i18n.promptShort") }) : "",
    pkg.counts.themes ? t("i18n.resourceCount", { count: pkg.counts.themes, label: t("i18n.themeShort") }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("i18n.noResources");
}

function versionSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  const parts = [];
  if (pkg.version) parts.push(t("i18n.installedVersion", { version: pkg.version }));
  if (pkg.configuredVersion) parts.push(t("i18n.configuredVersion", { version: pkg.configuredVersion }));
  return parts.length ? parts.join(" · ") : t("i18n.unknown");
}

function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "#f59e0b";
  if (status === "disabled") return "var(--text-dim)";
  return "#ef4444";
}

function ResourceList({ pkg }: { pkg: PluginPackageInfo }) {
  const { t } = useI18n();
  const groups = ([
    ["skill", t("i18n.skills")],
    ["agent", t("i18n.agents")],
    ["hook", t("i18n.hooks")],
    ["mcp", t("i18n.mcpServers")],
    ["extension", t("i18n.extensions")],
    ["prompt", t("i18n.prompts")],
    ["theme", t("i18n.themes")],
  ] as const)
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0);

  if (groups.length === 0) {
    return (
      <div style={{ fontSize: "var(--text-meta)", color: "var(--text-dim)" }}>
        {pkg.disabled ? t("i18n.packageDisabled") : t("i18n.noResolvedResources")}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.kind}
          style={{
            borderTop: groupIndex === 0 ? "none" : "1px solid var(--border)",
            paddingTop: groupIndex === 0 ? 0 : 12,
          }}
        >
          <div
            style={{
              fontSize: "var(--text-meta)",
              fontWeight: 700,
              color: "var(--text-dim)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {group.label}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.resources.map((resource) => (
              <div key={`${resource.kind}:${resource.path}`} style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "var(--text-meta)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={resource.path}
                >
                  {resource.name}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-meta)",
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: 1,
                  }}
                  title={resource.path}
                >
                  {resource.relativePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScopeTag({ scope }: { scope: PluginScope }) {
  return (
    <span
      style={{
        fontSize: "var(--text-meta)",
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
        color: scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-dim)",
      }}
    >
      {scope}
    </span>
  );
}

function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: danger ? "rgba(239,68,68,0.08)" : "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: danger ? "#ef4444" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "var(--text-ui)",
    opacity: disabled ? 0.5 : 1,
  };
}

function Toggle({
  enabled,
  loading,
  onToggle,
  label,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
        opacity: loading ? 0.65 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

function PackageDetail({
  pkg,
  cwd,
  busyKey,
  actionError,
  actionMessage,
  sessionId,
  variant,
  onAction,
  onReloadSession,
}: {
  pkg: PluginPackageInfo;
  cwd: string;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  sessionId: string | null;
  variant: PluginsVariant;
  onAction: (action: PluginAction, pkg: PluginPackageInfo) => void;
  onReloadSession: () => void;
}) {
  const { t } = useI18n();
  const key = packageKey(pkg);
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const enabled = !pkg.disabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, minWidth: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          <Toggle
            enabled={enabled}
            loading={busy || reloadBusy}
            onToggle={() => onAction(pkg.disabled ? "enable" : "disable", pkg)}
            label={pkg.disabled ? t("i18n.enablePackage") : t("i18n.disablePackage")}
          />
          <ScopeTag scope={pkg.scope} />
          {pkg.disabled ? (
            <span
              style={{
                fontSize: "var(--text-meta)",
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-dim)",
              }}
            >
              {t("i18n.disabled")}
            </span>
          ) : pkg.filtered && (
            <span
              style={{
                fontSize: "var(--text-meta)",
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(245,158,11,0.12)",
                color: "#d97706",
              }}
            >
              {t("i18n.filtered")}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-meta)",
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pkg.source}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {variant !== "mcp" && (
            <button
              onClick={() => onAction("update", pkg)}
              disabled={busy || reloadBusy}
              style={buttonStyle(busy || reloadBusy)}
            >
               {busyKey === `update:${key}` ? t("i18n.updating") : t("i18n.update")}
            </button>
          )}
          <button
            onClick={onReloadSession}
            disabled={!sessionId || reloadBusy || busy}
            style={buttonStyle(!sessionId || reloadBusy || busy)}
             title={sessionId ? t("i18n.reloadSession") : t("i18n.openSessionToReload")}
          >
             {reloadBusy ? t("i18n.reloading") : t("i18n.reloadSession")}
          </button>
          {pkg.origin !== "plugin" && (
            <button
              onClick={() => onAction("remove", pkg)}
              disabled={busy || reloadBusy}
              style={buttonStyle(busy || reloadBusy, true)}
            >
               {busyKey === `remove:${key}` ? t("i18n.removing") : t("i18n.remove")}
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: "var(--text-meta)",
          lineHeight: "var(--leading-prose)",
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.status")}</div>
        <div style={{ color: statusColor(pkg.status), textTransform: "capitalize" }}>
          {pkg.status}{pkg.trusted === false ? ` · ${t("i18n.untrusted")}` : ""}
        </div>
        {variant !== "mcp" && (
          <>
            <div style={{ color: "var(--text-dim)" }}>{t("i18n.version")}</div>
             <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{versionSummary(pkg, t)}</div>
          </>
        )}
        {pkg.pluginName ? (
          <>
            <div style={{ color: "var(--text-dim)" }}>{t("common.plugins")}</div>
            <div style={{ color: "var(--text-muted)" }}>{t("i18n.mcpFromPlugin", { name: pkg.pluginName })}</div>
          </>
        ) : null}
        {pkg.description ? (
          <>
            <div style={{ color: "var(--text-dim)" }}>{t("i18n.description")}</div>
            <div style={{ color: "var(--text-muted)" }}>{pkg.description}</div>
          </>
        ) : null}
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.package")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {pkg.packageName ?? t("i18n.unknown")}
        </div>
        {variant !== "mcp" && (
          <>
            <div style={{ color: "var(--text-dim)" }}>{t("i18n.resources")}</div>
            <div style={{ color: "var(--text-muted)" }}>{resourceSummary(pkg, t)}</div>
          </>
        )}
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.installedPath")}</div>
        <div
          style={{
            color: pkg.installedPath ? "var(--text-muted)" : "#ef4444",
            fontFamily: "var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {pkg.installedPath ? shortenPath(pkg.installedPath) : t("i18n.notFound")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.cwd")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      {variant !== "mcp" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: "var(--text-meta)", fontWeight: 700, color: "var(--text)" }}>
            {t("i18n.resolvedResources")}
          </div>
          <ResourceList pkg={pkg} />
        </div>
      )}

      {actionMessage && (
        <div style={{ fontSize: "var(--text-meta)", color: "#16a34a" }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ fontSize: "var(--text-meta)", color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

function marketplacePluginKey(source: MarketplaceSourceInfo, plugin: MarketplacePluginInfo): string {
  return `${source.sourceUrlOrPath}\0${plugin.relativePath}`;
}

export function PluginsConfig({
  cwd,
  sessionId,
  onReloaded,
  onControllerChange,
  variant = "plugins",
  initialView = "plugins",
}: {
  cwd: string;
  sessionId: string | null;
  onReloaded?: () => void;
  onControllerChange?(controller: SettingsSectionController): void;
  variant?: PluginsVariant;
  initialView?: PluginsView;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const apiPath = variant === "mcp" ? "/api/mcp" : "/api/plugins";
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [view, setView] = useState<PluginsView>(variant === "mcp" ? "plugins" : initialView);
  const [installSource, setInstallSource] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [marketplaceUrl, setMarketplaceUrl] = useState("");
  const [selectedMarketPlugin, setSelectedMarketPlugin] = useState<string | null>(null);

  const packages = useMemo(() => data?.packages ?? [], [data?.packages]);
  const sources = useMemo(() => data?.marketplace?.sources ?? [], [data?.marketplace?.sources]);
  const selectedPackage = packages.find((pkg) => packageKey(pkg) === selected) ?? null;
  const projectResourcesLoaded = data?.projectResourcesLoaded ?? true;
  const showMarketplace = variant === "plugins";

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiPath}?cwd=${encodeURIComponent(cwd)}`);
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setSelected((current) => {
        const repaired = resolvePluginsSelection(current, next.packages);
        if (repaired) return repaired;
        if (current) {
          setMobileView("list");
          return null;
        }
        return next.packages[0] ? pluginIdentity(next.packages[0]) : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiPath, cwd]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const postPlugins = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch(apiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, ...body }),
    });
    const next = (await res.json()) as PluginsResponse & { error?: string };
    if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
    setData(next);
    return next;
  }, [apiPath, cwd]);

  const reloadIfNeeded = useCallback(async () => {
    if (!sessionId) return;
    await sendAgentCommand(sessionId, { type: "reload" });
    onReloaded?.();
  }, [onReloaded, sessionId]);

  const runAction = useCallback(async (action: PluginAction, pkg: PluginPackageInfo) => {
    const key = packageKey(pkg);
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const next = await postPlugins({ action, source: pkg.source });
      if (action === "remove") {
        const nextId = next.packages[0] ? pluginIdentity(next.packages[0]) : null;
        setSelected(nextId);
        if (!nextId) {
          setMobileView(isMobile ? "list" : mobileView);
        }
        setActionMessage(t("i18n.packageRemoved"));
      } else {
        const messages: Record<Exclude<PluginAction, "remove">, string> = {
          update: t("i18n.packageUpdated"),
          disable: t("i18n.packageDisabled"),
          enable: t("i18n.packageEnabled"),
        };
        setActionMessage(messages[action]);
      }
      await reloadIfNeeded();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [isMobile, mobileView, postPlugins, reloadIfNeeded, t]);

  const runAddMcp = useCallback(async () => {
    const name = mcpName.trim();
    const command = mcpCommand.trim();
    if (!name || !command) return;
    setBusyKey("add");
    setActionError(null);
    setActionMessage(null);
    try {
      const next = await postPlugins({ action: "add", source: name, command });
      setMcpName("");
      setMcpCommand("");
      setActionMessage(t("i18n.mcpAdded"));
      const added = next.packages.find((pkg) => pkg.source === name);
      if (added) setSelected(pluginIdentity(added));
      await reloadIfNeeded();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [mcpCommand, mcpName, postPlugins, reloadIfNeeded, t]);

  const runInstall = useCallback(async () => {
    const source = installSource.trim();
    if (!source) return;
    setBusyKey("install");
    setActionError(null);
    setActionMessage(null);
    try {
      await postPlugins({ action: "install", source });
      setInstallSource("");
      setActionMessage(t("i18n.packageInstalled"));
      await reloadIfNeeded();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [installSource, postPlugins, reloadIfNeeded, t]);

  const runMarketplaceAction = useCallback(async (
    action: string,
    extra: Record<string, unknown>,
    busy: string,
    message: string,
  ) => {
    setBusyKey(busy);
    setActionError(null);
    setActionMessage(null);
    try {
      await postPlugins({ action, ...extra });
      setActionMessage(message);
      await reloadIfNeeded();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [postPlugins, reloadIfNeeded]);

  const reloadSession = useCallback(async () => {
    if (!sessionId) return;
    setBusyKey("reload");
    setActionError(null);
    setActionMessage(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded?.();
      await loadPlugins();
      setActionMessage(t("i18n.sessionReloaded"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [loadPlugins, onReloaded, sessionId, t]);

  const filtered = useMemo(() => filterPluginsNavigation(packages, query), [packages, query]);
  const filteredSources = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return sources;
    return sources
      .map((source) => ({
        ...source,
        plugins: source.plugins.filter((plugin) => (
          [plugin.name, plugin.description ?? "", source.sourceName]
            .some((value) => value.toLocaleLowerCase().includes(q))
        )),
      }))
      .filter((source) => (
        source.sourceName.toLocaleLowerCase().includes(q) || source.plugins.length > 0
      ));
  }, [query, sources]);
  const selectedMarket = useMemo(() => {
    for (const source of sources) {
      for (const plugin of source.plugins) {
        const id = pluginIdentity({
          scope: "global",
          source: marketplacePluginKey(source, plugin),
        });
        if (id === selectedMarketPlugin) {
          return { source, plugin };
        }
      }
    }
    return null;
  }, [selectedMarketPlugin, sources]);
  const headerLabel = pluginsSelectionLabel(selected, packages);

  const handleBack = useCallback(() => {
    if (isMobile && mobileView === "detail") { setMobileView("list"); return true; }
    return false;
  }, [isMobile, mobileView]);

  const controller = useMemo<SettingsSectionController>(() => ({
    handleBack,
    mobileDetailOpen: isMobile && mobileView === "detail",
  }), [handleBack, isMobile, mobileView]);

  useEffect(() => {
    onControllerChange?.(controller);
  }, [controller, onControllerChange]);

  const openDetail = (id: string | null) => {
    if (id) setSelected(id);
    setActionError(null);
    setActionMessage(null);
    if (isMobile) setMobileView("detail");
  };

  const title = variant === "mcp" ? t("common.mcp") : t("common.plugins");

  return (
    <div className="resource-settings-page">
      <div className="resource-settings-header">
        {isMobile && mobileView === "detail" ? (
          <>
            <button type="button" className="resource-settings-back" onClick={() => { setMobileView("list"); }} aria-label={t("i18n.back")}>
              <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            <div className="resource-settings-header-title">
              <span>{view === "marketplace" ? (selectedMarket?.plugin.name ?? t("common.marketplace")) : headerLabel.title}</span>
            </div>
          </>
        ) : (
          <div className="resource-settings-header-title">
            <span>{title}</span>
            <code>{shortenPath(cwd)}</code>
          </div>
        )}
      </div>

      {showMarketplace && !(isMobile && mobileView === "detail") && (
        <div className="resource-settings-tabs" role="tablist" aria-label={t("common.plugins")}>
          <button type="button" role="tab" className="resource-settings-tab" aria-selected={view === "plugins"} data-active={view === "plugins"} onClick={() => { setView("plugins"); setMobileView("list"); }}>
            {t("common.plugins")}
          </button>
          <button type="button" role="tab" className="resource-settings-tab" aria-selected={view === "marketplace"} data-active={view === "marketplace"} onClick={() => { setView("marketplace"); setMobileView("list"); }}>
            {t("common.marketplace")}
          </button>
        </div>
      )}

      {!projectResourcesLoaded && (
        <div className="resource-settings-banner" role="status">{t("trust.pluginsNotLoaded")}</div>
      )}

      {data?.diagnostics.length ? (
        <div className="resource-settings-banner" role="status">
          {data.diagnostics.map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`).join(" · ")}
        </div>
      ) : null}

      {view === "marketplace" && showMarketplace ? (
        <div className="resource-settings-layout" data-mobile-view={isMobile ? mobileView : undefined}>
            <PluginsNavigator
              query={query}
              selection={selectedMarketPlugin}
              project={[]}
              global={filteredSources.flatMap((source) => source.plugins.map((plugin) => ({
                source: marketplacePluginKey(source, plugin),
                scope: "global" as const,
                packageName: plugin.name,
                status: plugin.installStatus === "installed" ? t("i18n.installed") : t("i18n.notInstalled"),
              })))}
              loading={loading}
              error={error ?? undefined}
              busy={Boolean(busyKey)}
              searchPlaceholder={t("resources.searchMarketplace")}
              emptyMessage={query.trim() ? t("resources.noMatchingMarketplace") : t("i18n.noMarketplaces")}
              leading={(
                <form
                  className="resource-settings-install"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const url = marketplaceUrl.trim();
                    if (!url) return;
                    setMarketplaceUrl("");
                    void runMarketplaceAction("add_source", { url }, "add_source", t("i18n.packageInstalled"));
                  }}
                >
                  <input
                    value={marketplaceUrl}
                    onChange={(event) => setMarketplaceUrl(event.target.value)}
                    placeholder={t("i18n.installPluginPlaceholder")}
                    aria-label={t("i18n.addMarketplace")}
                  />
                  <button type="submit" className="resource-settings-header-button" disabled={Boolean(busyKey) || !marketplaceUrl.trim()}>
                    {t("i18n.addMarketplace")}
                  </button>
                </form>
              )}
              onQueryChange={setQuery}
              onSelect={(id) => {
                setSelectedMarketPlugin(id);
                setActionError(null);
                setActionMessage(null);
                if (isMobile) setMobileView("detail");
              }}
              onRetry={() => void loadPlugins()}
            />
          <div className="resource-settings-detail">
            {loading ? null : selectedMarket ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 680 }}>
                <div>
                  <div style={{ fontSize: "var(--text-title)", fontWeight: 700 }}>{selectedMarket.plugin.name}</div>
                  <div style={{ color: "var(--text-muted)", marginTop: 4 }}>{selectedMarket.plugin.description}</div>
                </div>
                <div style={{ color: "var(--text-dim)", fontSize: "var(--text-meta)", fontFamily: "var(--font-mono)" }}>
                  {selectedMarket.source.sourceName} · {selectedMarket.plugin.relativePath}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => void runMarketplaceAction(
                      "marketplace_install",
                      {
                        source_url_or_path: selectedMarket.source.sourceUrlOrPath,
                        plugin_relative_path: selectedMarket.plugin.relativePath,
                      },
                      `install:${marketplacePluginKey(selectedMarket.source, selectedMarket.plugin)}`,
                      t("i18n.packageInstalled"),
                    )}
                    disabled={Boolean(busyKey) || selectedMarket.plugin.installStatus === "installed"}
                    style={buttonStyle(Boolean(busyKey) || selectedMarket.plugin.installStatus === "installed")}
                  >
                    {t("i18n.install")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runMarketplaceAction(
                      "remove_source",
                      { source_url_or_path: selectedMarket.source.sourceUrlOrPath },
                      `remove_source:${selectedMarket.source.sourceUrlOrPath}`,
                      t("i18n.packageRemoved"),
                    )}
                    disabled={Boolean(busyKey)}
                    style={buttonStyle(Boolean(busyKey), true)}
                  >
                    {t("i18n.removeSource")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runMarketplaceAction("refresh", {}, "refresh", t("i18n.packageUpdated"))}
                    disabled={Boolean(busyKey)}
                    style={buttonStyle(Boolean(busyKey))}
                  >
                    {t("i18n.refreshSources")}
                  </button>
                </div>
                {actionMessage && <div style={{ fontSize: "var(--text-meta)", color: "#16a34a" }}>{actionMessage}</div>}
                {actionError && <div style={{ fontSize: "var(--text-meta)", color: "#ef4444", whiteSpace: "pre-wrap" }}>{actionError}</div>}
              </div>
            ) : (
              <div className="resource-settings-detail-empty">
                {sources.length ? t("i18n.selectPackage") : t("i18n.noMarketplaces")}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="resource-settings-layout" data-mobile-view={isMobile ? mobileView : undefined}>
            <PluginsNavigator
              query={query}
              selection={selected}
              project={filtered.project}
              global={filtered.global}
              loading={loading}
              error={error ?? undefined}
              busy={Boolean(busyKey)}
              emptyMessage={query.trim()
                ? t("resources.noMatchingPlugins")
                : variant === "mcp" ? t("i18n.noMcp") : t("i18n.noPlugins")}
              leading={variant === "plugins" ? (
                <form
                  className="resource-settings-install"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runInstall();
                  }}
                >
                  <input
                    value={installSource}
                    onChange={(event) => setInstallSource(event.target.value)}
                    placeholder={t("i18n.installPluginPlaceholder")}
                    aria-label={t("i18n.addPlugin")}
                  />
                  <button type="submit" className="resource-settings-header-button" disabled={Boolean(busyKey) || !installSource.trim()}>
                    {t("i18n.install")}
                  </button>
                </form>
              ) : (
                <form
                  className="resource-settings-install"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runAddMcp();
                  }}
                >
                  <input
                    value={mcpName}
                    onChange={(event) => setMcpName(event.target.value)}
                    placeholder={t("i18n.mcpNamePlaceholder")}
                    aria-label={t("i18n.mcpNamePlaceholder")}
                  />
                  <input
                    value={mcpCommand}
                    onChange={(event) => setMcpCommand(event.target.value)}
                    placeholder={t("i18n.mcpCommandPlaceholder")}
                    aria-label={t("i18n.mcpCommandPlaceholder")}
                  />
                  <button type="submit" className="resource-settings-header-button" disabled={Boolean(busyKey) || !mcpName.trim() || !mcpCommand.trim()}>
                    {t("i18n.addMcp")}
                  </button>
                </form>
              )}
              onQueryChange={setQuery}
              onSelect={(id) => openDetail(id)}
              onRetry={() => void loadPlugins()}
            />
          <div className="resource-settings-detail">
            {loading ? null : selectedPackage ? (
              <PackageDetail
                key={packageKey(selectedPackage)}
                pkg={selectedPackage}
                cwd={cwd}
                busyKey={busyKey}
                actionError={actionError}
                actionMessage={actionMessage}
                sessionId={sessionId}
                variant={variant}
                onAction={runAction}
                onReloadSession={reloadSession}
              />
            ) : (
              <div className="resource-settings-detail-empty">{t("i18n.selectPackage")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
