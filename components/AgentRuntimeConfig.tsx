"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { RuntimeProfile } from "@/lib/runtime-profile";

const DEFAULT_PROFILE: RuntimeProfile = {
  version: 1,
  agent: null,
  agentProfilePath: null,
  sandbox: null,
  permissionMode: "default",
  allow: [],
  deny: [],
  disableWebSearch: false,
  disableSubagents: false,
  maxTurns: null,
  rules: null,
};

type CapabilitySnapshot = { version: string; globalFlags: string[]; agentFlags: string[]; agents: Array<{ name: string; description?: string }> };

export function AgentRuntimeConfig({ onDirtyChange, discardSignal }: { onDirtyChange?: (dirty: boolean) => void; discardSignal?: number }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<RuntimeProfile>(DEFAULT_PROFILE);
  const [draft, setDraft] = useState<RuntimeProfile>(DEFAULT_PROFILE);
  const [capabilities, setCapabilities] = useState<CapabilitySnapshot>({ version: "unknown", globalFlags: [], agentFlags: [], agents: [] });
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { if (discardSignal !== undefined) setDraft(saved); }, [discardSignal]);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/runtime-profile", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      if (cancelled) return;
      if (body.profile) { setSaved(body.profile); setDraft(body.profile); }
      if (body.warnings?.length) setWarning(body.warnings.join(" "));
      if (body.capabilities) setCapabilities(body.capabilities);
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);
  const set = <K extends keyof RuntimeProfile>(key: K, value: RuntimeProfile[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const apply = async () => {
    if (saving || !dirty) return;
    if (!window.confirm(t("runtime.confirmRestart"))) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch("/api/runtime-profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const next = body.profile as RuntimeProfile;
      setSaved(next); setDraft(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };
  const has = (flag: string) => capabilities.globalFlags.includes(flag);
  return (
    <div className="settings-form-page" data-testid="agent-runtime-config">
      <div className="settings-form-heading"><h3>{t("runtime.title")}</h3><p>{t("runtime.description", { version: capabilities.version })}</p></div>
      {warning && <div className="settings-inline-error" role="alert">{warning}</div>}
      {error && <div className="settings-inline-error" role="alert">{error}</div>}
      {has("--agent") && <label className="settings-form-section"><span>{t("runtime.agent")}</span><select value={draft.agent ?? ""} onChange={(event) => set("agent", event.target.value || null)}><option value="">{t("runtime.agentDefault")}</option>{capabilities.agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}</select></label>}
      {capabilities.agentFlags.includes("--agent-profile") && <label className="settings-form-section"><span>{t("runtime.agentProfilePath")}</span><input value={draft.agentProfilePath ?? ""} onChange={(event) => set("agentProfilePath", event.target.value || null)} placeholder={t("runtime.agentProfilePlaceholder")} /></label>}
      {has("--sandbox") && <label className="settings-form-section"><span>{t("runtime.sandbox")}</span><input value={draft.sandbox ?? ""} onChange={(event) => set("sandbox", event.target.value || null)} placeholder="workspace" /></label>}
      {has("--permission-mode") && <label className="settings-form-section"><span>{t("settings.permissionMode")}</span><select value={draft.permissionMode} onChange={(event) => set("permissionMode", event.target.value as RuntimeProfile["permissionMode"])}>{["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"].map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>}
      {has("--max-turns") && <label className="settings-form-section"><span>{t("runtime.maxTurns")}</span><input type="number" min={1} max={1000} value={draft.maxTurns ?? ""} onChange={(event) => set("maxTurns", event.target.value ? Number(event.target.value) : null)} /></label>}
      {has("--rules") && <label className="settings-form-section"><span>{t("runtime.rules")}</span><textarea value={draft.rules ?? ""} onChange={(event) => set("rules", event.target.value || null)} /></label>}
      {has("--allow") && <label className="settings-form-section"><span>{t("runtime.allow")}</span><textarea value={draft.allow.join("\n")} onChange={(event) => set("allow", event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))} /></label>}
      {has("--deny") && <label className="settings-form-section"><span>{t("runtime.deny")}</span><textarea value={draft.deny.join("\n")} onChange={(event) => set("deny", event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))} /></label>}
      {has("--disable-web-search") && <label className="settings-form-section"><span><input type="checkbox" checked={draft.disableWebSearch} onChange={(event) => set("disableWebSearch", event.target.checked)} /> {t("runtime.disableWebSearch")}</span></label>}
      {has("--no-subagents") && <label className="settings-form-section"><span><input type="checkbox" checked={draft.disableSubagents} onChange={(event) => set("disableSubagents", event.target.checked)} /> {t("runtime.disableSubagents")}</span></label>}
      <div className="settings-form-actions"><button type="button" disabled={!dirty || saving} onClick={() => void apply()}>{t("runtime.apply")}</button></div>
    </div>
  );
}
