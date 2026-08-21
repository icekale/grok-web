"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  Bell,
  Cpu,
  Gauge,
  GlobeLock,
  Info,
  Languages,
  Layers3,
  Monitor,
  Moon,
  Cable,
  Plug,
  Shield,
  SlidersHorizontal,
  Sun,
  Volume2,
} from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import type { ThemePreference } from "@/hooks/useTheme";
import type { Locale, LocalePlugin } from "@/lib/i18n/types";
import { readArchivedSessionIds, rememberArchivedSessionIds, writeArchivedSessionIds } from "@/lib/archived-sessions";
import { sidebarSessionTitle } from "@/lib/codex-sidebar-search";
import type { ProjectPreference } from "@/lib/project-registry";
import type { SessionInfo } from "@/lib/types";
import { ModelsConfig } from "./ModelsConfig";
import type { ModelsDraftController } from "./models-config/models-config-types";
import type { SettingsSectionController } from "./resource-settings/resource-settings-types";
import { PluginsConfig } from "./PluginsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { RemoteAccessConfig, type RemoteDraftController } from "./RemoteAccessConfig";
import { DialogShell } from "./DialogShell";

export type SettingsSection = "general" | "remote" | "archived" | "models" | "skills" | "plugins" | "marketplace" | "mcp";

interface Props {
  cwd: string | null;
  sessionId: string | null;
  themePreference: ThemePreference;
  onThemeChange: (preference: ThemePreference) => void;
  locale: Locale;
  supportedLocales: LocalePlugin[];
  onLocaleChange: (locale: Locale) => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
  tokenSpeedEnabled: boolean;
  onTokenSpeedToggle: () => void;
  onClose: () => void;
  onModelsChanged: () => void;
  onSessionReloaded: () => void;
  onProjectsChanged: () => void;
  onRegisterSettingsBack: (handler: () => boolean) => void;
  initialSection?: SettingsSection;
}

function SectionIcon({ section }: { section: SettingsSection }) {
  const icons = {
    general: SlidersHorizontal,
    remote: GlobeLock,
    archived: Archive,
    models: Cpu,
    skills: Layers3,
    plugins: Plug,
    marketplace: Plug,
    mcp: Cable,
  };
  const Icon = icons[section];
  return <Icon size={16} strokeWidth={1.8} aria-hidden="true" />;
}

export function SettingsPage({
  cwd,
  sessionId,
  themePreference,
  onThemeChange,
  locale,
  supportedLocales,
  onLocaleChange,
  soundEnabled,
  onSoundToggle,
  tokenSpeedEnabled,
  onTokenSpeedToggle,
  onClose,
  onModelsChanged,
  onSessionReloaded,
  onProjectsChanged,
  onRegisterSettingsBack,
  initialSection = "general",
}: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [projects, setProjects] = useState<ProjectPreference[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [archivedSessionIds, setArchivedSessionIds] = useState<Set<string>>(() => new Set());
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [restoringProjects, setRestoringProjects] = useState<Set<string>>(new Set());
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [modelsController, setModelsController] = useState<ModelsDraftController | null>(null);
  const [skillsController, setSkillsController] = useState<SettingsSectionController | null>(null);
  const [pluginsController, setPluginsController] = useState<SettingsSectionController | null>(null);
  const [remoteController, setRemoteController] = useState<RemoteDraftController | null>(null);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [pendingExit, setPendingExit] = useState<(() => void) | null>(null);
  const [permissionMode, setPermissionMode] = useState<"ask" | "auto" | "always-approve">("ask");
  const [permissionSaving, setPermissionSaving] = useState(false);

  const close = useCallback(() => {
    onModelsChanged();
    onClose();
  }, [onClose, onModelsChanged]);

  // One exit-request path: every Settings close/navigation action goes through
  // here so unsaved custom model drafts are never lost silently.
  const requestCloseOrNavigate = useCallback((action: () => void) => {
    if (modelsController?.dirty || remoteController?.dirty) {
      setPendingExit(() => action);
      setDiscardDialogOpen(true);
    } else {
      action();
    }
  }, [modelsController, remoteController]);

  const handleDiscardConfirm = useCallback(() => {
    const action = pendingExit;
    setDiscardDialogOpen(false);
    setPendingExit(null);
    setModelsController(null);
    setRemoteController(null);
    modelsController?.discard();
    remoteController?.discard();
    action?.();
  }, [modelsController, pendingExit, remoteController]);

  const activeController = section === "models"
    ? modelsController
    : section === "skills"
      ? skillsController
      : section === "plugins"
        ? pluginsController
          : section === "remote"
            ? remoteController
            : null;

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { permissionMode?: string } | null) => {
        if (cancelled) return;
        if (body?.permissionMode === "auto" || body?.permissionMode === "always-approve" || body?.permissionMode === "ask") {
          setPermissionMode(body.permissionMode);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const savePermissionMode = useCallback(async (mode: "ask" | "auto" | "always-approve") => {
    if (permissionSaving || mode === permissionMode) return;
    const previous = permissionMode;
    setPermissionMode(mode);
    setPermissionSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionMode: mode }),
      });
      const body = await response.json().catch(() => ({})) as { permissionMode?: string; error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (body.permissionMode === "auto" || body.permissionMode === "always-approve" || body.permissionMode === "ask") {
        setPermissionMode(body.permissionMode);
      }
    } catch {
      setPermissionMode(previous);
    } finally {
      setPermissionSaving(false);
    }
  }, [permissionMode, permissionSaving]);

  const handleSettingsBack = useCallback((): boolean => {
    if (activeController?.handleBack()) return true;
    if (modelsController?.dirty || remoteController?.dirty) {
      setPendingExit(() => close);
      setDiscardDialogOpen(true);
      return true;
    }
    return false;
  }, [activeController, close, modelsController, remoteController]);

  useEffect(() => {
    onRegisterSettingsBack(handleSettingsBack);
  }, [onRegisterSettingsBack, handleSettingsBack]);

  const loadProjects = useCallback(async (clearError = true) => {
    setProjectsLoading(true);
    if (clearError) setProjectsError(null);
    try {
      const [projectsResponse, sessionsResponse] = await Promise.all([
        fetch("/api/projects", { cache: "no-store" }),
        fetch("/api/sessions", { cache: "no-store" }),
      ]);
      if (!projectsResponse.ok) throw new Error(`HTTP ${projectsResponse.status}`);
      const projectData = await projectsResponse.json() as { projects: ProjectPreference[] };
      setProjects(projectData.projects);
      if (sessionsResponse.ok) {
        const sessionData = await sessionsResponse.json() as {
          sessions: SessionInfo[];
          meta?: { archivedIds?: string[] };
        };
        setSessions(sessionData.sessions);
        if (sessionData.meta) rememberArchivedSessionIds(sessionData.meta.archivedIds ?? []);
      }
      setArchivedSessionIds(readArchivedSessionIds());
    } catch (cause) {
      setProjectsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (section === "archived") void loadProjects();
  }, [loadProjects, section]);

  const restoreProject = useCallback(async (path: string) => {
    if (restoringProjects.has(path)) return;
    setRestoringProjects((current) => new Set(current).add(path));
    setProjectsError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, update: { archived: false } }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setProjects((current) => current.map((project) => project.path === path ? { ...project, archived: false } : project));
      onProjectsChanged();
    } catch (cause) {
      setProjectsError(cause instanceof Error ? cause.message : String(cause));
      void loadProjects(false);
    } finally {
      setRestoringProjects((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  }, [loadProjects, onProjectsChanged, restoringProjects]);

  const restoreSession = useCallback((id: string) => {
    setArchivedSessionIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      writeArchivedSessionIds(next);
      return next;
    });
    onProjectsChanged();
  }, [onProjectsChanged]);

  const sections: { id: SettingsSection; label: string; disabled: boolean }[] = [
    { id: "general", label: t("settings.general"), disabled: false },
    { id: "models", label: t("common.models"), disabled: false },
    { id: "skills", label: t("common.skills"), disabled: !cwd },
    { id: "plugins", label: t("common.plugins"), disabled: !cwd },
    { id: "mcp", label: t("common.mcp"), disabled: !cwd },
    { id: "remote", label: t("remote.nav"), disabled: false },
    { id: "archived", label: t("sidebar.archived"), disabled: false },
  ];

  let content: ReactNode;
  if (section === "general") {
    const themes: { id: ThemePreference; label: string; Icon: typeof Sun }[] = [
      { id: "light", label: t("settings.themeLight"), Icon: Sun },
      { id: "dark", label: t("settings.themeDark"), Icon: Moon },
      { id: "auto", label: t("settings.themeSystem"), Icon: Monitor },
    ];
    content = (
      <div className="settings-form-page">
        <div className="settings-form-heading">
          <SlidersHorizontal size={18} aria-hidden="true" />
          <div><h3>{t("settings.general")}</h3><p>{t("settings.generalDescription")}</p></div>
        </div>
        <section className="settings-form-section">
          <div className="settings-form-label"><Sun size={16} aria-hidden="true" /><div><strong>{t("settings.appearance")}</strong><span>{t("settings.appearanceDescription")}</span></div></div>
          <div className="settings-segmented" role="radiogroup" aria-label={t("settings.appearance")}>
            {themes.map(({ id, label, Icon }) => (
              <button key={id} type="button" role="radio" aria-checked={themePreference === id} data-active={themePreference === id} onClick={() => onThemeChange(id)}>
                <Icon size={15} aria-hidden="true" /><span>{label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-form-section">
          <label className="settings-form-label" htmlFor="settings-language"><Languages size={16} aria-hidden="true" /><div><strong>{t("common.language")}</strong><span>{t("settings.languageDescription")}</span></div></label>
          <select id="settings-language" value={locale} onChange={(event) => onLocaleChange(event.target.value as Locale)}>
            {supportedLocales.map((plugin) => <option key={plugin.id} value={plugin.id}>{plugin.label}</option>)}
          </select>
        </section>
        <section className="settings-form-section">
          <div className="settings-form-label"><Bell size={16} aria-hidden="true" /><div><strong>{t("settings.completionSound")}</strong><span>{t("settings.completionSoundDescription")}</span></div></div>
          <button className="settings-switch" type="button" role="switch" aria-checked={soundEnabled} onClick={onSoundToggle} title={t("settings.completionSound")}>
            <span /><Volume2 size={15} aria-hidden="true" />
          </button>
        </section>
        <section className="settings-form-section">
          <div className="settings-form-label"><Gauge size={16} aria-hidden="true" /><div><strong>{t("settings.tokenSpeed")}</strong><span>{t("settings.tokenSpeedDescription")}</span></div></div>
          <button className="settings-switch" type="button" role="switch" aria-checked={tokenSpeedEnabled} onClick={onTokenSpeedToggle} title={t("settings.tokenSpeed")}>
            <span /><Gauge size={15} aria-hidden="true" />
          </button>
        </section>
        <section className="settings-form-section">
          <div className="settings-form-label"><Shield size={16} aria-hidden="true" /><div><strong>{t("settings.permissionMode")}</strong><span>{t("settings.permissionModeDescription")}</span></div></div>
          <div className="settings-segmented" role="radiogroup" aria-label={t("settings.permissionMode")}>
            {([
              { id: "ask" as const, label: t("settings.permissionAsk") },
              { id: "auto" as const, label: t("settings.permissionAuto") },
              { id: "always-approve" as const, label: t("settings.permissionAlwaysApprove") },
            ]).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={permissionMode === id}
                data-active={permissionMode === id}
                disabled={permissionSaving}
                onClick={() => void savePermissionMode(id)}
              >
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-form-section">
          <div className="settings-form-label"><Info size={16} aria-hidden="true" /><div><strong>{t("settings.about")}</strong><span>{t("settings.aboutVersion", { web: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0" })}</span></div></div>
        </section>
      </div>
    );
  } else if (section === "archived") {
    const archivedProjects = projects.filter((project) => project.archived && !project.removed);
    const archivedSessions = sessions.filter((session) => archivedSessionIds.has(session.id) && session.sessionRole !== "subagent");
    const archivedEmpty = archivedProjects.length === 0 && archivedSessions.length === 0;
    content = (
      <div className="settings-form-page">
        <div className="settings-form-heading"><Archive size={18} aria-hidden="true" /><div><h3>{t("sidebar.archived")}</h3><p>{t("settings.archivedEmptyDescription")}</p></div></div>
        {projectsLoading ? (
          <div className="settings-page-empty"><span>{t("sidebar.loading")}</span></div>
        ) : archivedEmpty ? (
          <div className="settings-page-empty"><Archive size={20} aria-hidden="true" /><strong>{t("sidebar.noArchivedProjects")}</strong><span>{t("settings.archivedEmptyDescription")}</span></div>
        ) : (
          <>
            {archivedProjects.length > 0 && (
              <>
                <div className="settings-form-heading"><div><h3>{t("sidebar.archivedProjects")}</h3><p>{t("settings.archivedProjectsDescription")}</p></div></div>
                <div className="settings-archived-list">
                  {archivedProjects.map((project) => (
                    <div className="settings-archived-row" key={project.path}>
                      <div><strong>{project.name ?? project.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? project.path}</strong><span title={project.path}>{project.path}</span></div>
                      <button type="button" disabled={restoringProjects.has(project.path)} onClick={() => void restoreProject(project.path)}><ArchiveRestore size={14} aria-hidden="true" />{t("sidebar.restoreProject")}</button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {archivedSessions.length > 0 && (
              <>
                <div className="settings-form-heading"><div><h3>{t("sidebar.archivedSessions")}</h3><p>{t("settings.archivedSessionsDescription")}</p></div></div>
                <div className="settings-archived-list">
                  {archivedSessions.map((session) => (
                    <div className="settings-archived-row" key={session.id}>
                      <div><strong>{sidebarSessionTitle(session)}</strong><span title={session.cwd}>{session.cwd}</span></div>
                      <button type="button" onClick={() => restoreSession(session.id)}><ArchiveRestore size={14} aria-hidden="true" />{t("sidebar.restoreSession")}</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {projectsError && <div className="settings-inline-error" role="alert">{projectsError}</div>}
      </div>
    );
  } else if (section === "models") {
    content = <ModelsConfig cwd={cwd} onControllerChange={setModelsController} />;
  } else if (section === "remote") {
    content = <RemoteAccessConfig onControllerChange={setRemoteController} />;
  } else if (!cwd) {
    content = (
      <div className="settings-page-empty">
        <SectionIcon section={section} />
        <strong>{t("settings.projectRequired")}</strong>
        <span>{t("settings.projectRequiredDescription")}</span>
      </div>
    );
  } else if (section === "skills") {
    content = <SkillsConfig cwd={cwd} onControllerChange={setSkillsController} />;
  } else if (section === "mcp") {
    content = (
      <PluginsConfig
        cwd={cwd}
        sessionId={sessionId}
        variant="mcp"
        onReloaded={onSessionReloaded}
        onControllerChange={setPluginsController}
      />
    );
  } else {
    content = (
      <PluginsConfig
        key={section === "marketplace" ? "marketplace" : "plugins"}
        cwd={cwd}
        sessionId={sessionId}
        initialView={section === "marketplace" ? "marketplace" : "plugins"}
        onReloaded={onSessionReloaded}
        onControllerChange={setPluginsController}
      />
    );
  }

  return createPortal(
    <DialogShell
      size="page"
      title={t("common.settings")}
      ariaLabel={t("i18n.close")}
      showClose
      closeButtonRef={closeButtonRef}
      onClose={() => requestCloseOrNavigate(close)}
      onEscape={() => Boolean(activeController?.handleBack())}
      bodyClassName="settings-page-dialog-body"
      headerActions={null}
    >
      <div className="settings-page-layout">
        <nav
          className="settings-page-nav"
          aria-label={t("settings.categories")}
          data-hidden-mobile={activeController?.mobileDetailOpen ? "true" : undefined}
        >
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              data-active={section === item.id || (item.id === "plugins" && section === "marketplace")}
              disabled={item.disabled}
              title={item.disabled ? t("settings.selectProjectFirst") : item.label}
              onClick={() => requestCloseOrNavigate(() => setSection(item.id))}
            >
              <SectionIcon section={item.id} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <main className="settings-page-content">{content}</main>
      </div>
      {discardDialogOpen && (
        <DialogShell
          size="confirm"
          title={t("models.unsavedChanges")}
          ariaLabel={t("models.keepEditing")}
          onClose={() => setDiscardDialogOpen(false)}
          backdropDismissible={false}
          footer={(
            <>
              <button type="button" className="codex-dialog-button" onClick={() => setDiscardDialogOpen(false)}>{t("models.keepEditing")}</button>
              <button type="button" className="codex-dialog-button" data-variant="danger" onClick={handleDiscardConfirm}>{t("models.discard")}</button>
            </>
          )}
        >
          <p className="codex-dialog-copy">{t("models.discardChangesDescription")}</p>
        </DialogShell>
      )}
    </DialogShell>,
    document.body,
  );
}
