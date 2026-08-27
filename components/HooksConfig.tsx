"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DialogShell } from "./DialogShell";

type HookRow = {
  event: string;
  hookType: string;
  target: string;
  matcher: string | null;
  sourceType: string;
  pluginName?: string;
  sourcePath?: string;
  removable: boolean;
};

type HooksResponse = {
  projectTrusted: boolean;
  projectRoot: string | null;
  hooks: HookRow[];
  error?: string;
};

const HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionDenied", "Stop", "StopFailure", "StopCancelled", "Notification",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "SessionEnd",
];

const GROUPS = ["global", "project", "plugin", "config", "unknown"] as const;

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function HooksConfig({ cwd }: { cwd: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<HooksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [event, setEvent] = useState("SessionStart");
  const [hookType, setHookType] = useState<"command" | "http">("command");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [matcher, setMatcher] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/hooks?cwd=${encodeURIComponent(cwd)}`);
    const body = await res.json() as HooksResponse;
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setData(body);
  }, [cwd]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/hooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, ...body }),
      });
      const next = await res.json() as HooksResponse & { error?: string };
      if (!res.ok) throw new Error(next.error || `HTTP ${res.status}`);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const grouped = GROUPS.map((group) => ({
    group,
    hooks: (data?.hooks ?? []).filter((hook) => (hook.sourceType || "unknown") === group),
  })).filter((entry) => entry.hooks.length > 0);

  return (
    <div className="settings-form-page">
      <div className="settings-form-heading">
        <div>
          <h3>{t("common.hooks")}</h3>
          <p>{t("hooks.description")}</p>
        </div>
      </div>
      <div className="settings-form-section" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="codex-dialog-button" disabled={busy} onClick={() => post({ action: data?.projectTrusted ? "untrust" : "trust" })}>
          {data?.projectTrusted ? t("hooks.untrust") : t("hooks.trust")}
        </button>
        <button type="button" className="codex-dialog-button" data-variant="primary" disabled={busy} onClick={() => setAddOpen(true)}>
          {t("hooks.add")}
        </button>
        <button type="button" className="codex-dialog-button" disabled={busy} onClick={() => post({ action: "reload" })}>
          {t("hooks.reload")}
        </button>
      </div>
      {error && <div role="alert" className="settings-inline-error">{error}</div>}
      {grouped.length === 0 && <p className="settings-page-empty">{t("hooks.empty")}</p>}
      {grouped.map((entry) => (
        <section key={entry.group} className="settings-form-section">
          <h4>{t(`hooks.group.${entry.group}`)}</h4>
          {entry.hooks.map((hook) => (
            <div key={`${hook.sourceType}:${hook.target}:${hook.event}`} className="settings-archived-row">
              <div>
                <strong>{hook.pluginName || hook.event}</strong>
                <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: "var(--text-meta)" }}>
                  {shortenPath(hook.target)}{hook.matcher ? ` · ${hook.matcher}` : ""}
                </span>
              </div>
              {hook.removable ? (
                <button type="button" className="codex-dialog-button" disabled={busy} onClick={() => post({ action: "remove", target: hook.target })}>
                  {t("hooks.remove")}
                </button>
              ) : (
                <span>{t("hooks.readOnly")}</span>
              )}
            </div>
          ))}
        </section>
      ))}
      {addOpen && (
        <DialogShell
          size="request"
          title={t("hooks.add")}
          onClose={() => setAddOpen(false)}
          footer={(
            <>
              <button type="button" className="codex-dialog-button" onClick={() => setAddOpen(false)}>{t("chat.cancel")}</button>
              <button
                type="button"
                className="codex-dialog-button"
                data-variant="primary"
                disabled={busy}
                onClick={async () => {
                  await post({
                    action: "add",
                    event,
                    type: hookType,
                    command: hookType === "command" ? command : undefined,
                    url: hookType === "http" ? url : undefined,
                    matcher: matcher || undefined,
                  });
                  setAddOpen(false);
                }}
              >
                {t("hooks.add")}
              </button>
            </>
          )}
        >
          <label>{t("hooks.event")}
            <select value={event} onChange={(e) => setEvent(e.target.value)}>
              {HOOK_EVENTS.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>{t("hooks.type")}
            <select value={hookType} onChange={(e) => setHookType(e.target.value as "command" | "http")}>
              <option value="command">{t("hooks.typeCommand")}</option>
              <option value="http">{t("hooks.typeHttp")}</option>
            </select>
          </label>
          {hookType === "command" ? (
            <label>{t("hooks.command")}<input value={command} onChange={(e) => setCommand(e.target.value)} /></label>
          ) : (
            <label>{t("hooks.url")}<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          )}
          <label>{t("hooks.matcher")}<input value={matcher} onChange={(e) => setMatcher(e.target.value)} /></label>
        </DialogShell>
      )}
    </div>
  );
}
