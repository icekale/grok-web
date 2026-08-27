"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DialogShell } from "./DialogShell";

type MemoryFile = { scope: string; path: string; name: string; mtime: number };
type MemoryResponse = {
  enabled: boolean;
  envOverrides: boolean;
  files: MemoryFile[];
  preview: { path: string; text: string } | null;
  error?: string;
};

export function MemoryConfig({ cwd }: { cwd: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [rememberOpen, setRememberOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async (preview?: string) => {
    const query = new URLSearchParams({ cwd });
    if (preview) query.set("preview", preview);
    const res = await fetch(`/api/memory?${query}`);
    const body = await res.json() as MemoryResponse;
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setData(body);
    setSelected(body.preview?.path ?? null);
  }, [cwd]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, ...body }),
      });
      const next = await res.json() as MemoryResponse & { error?: string };
      if (!res.ok) throw new Error(next.error || `HTTP ${res.status}`);
      setData(next);
      setSelected(next.preview?.path ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-form-page">
      <div className="settings-form-heading">
        <div>
          <h3>{t("common.memory")}</h3>
          <p>{t("memory.description")}</p>
        </div>
      </div>
      <div className="settings-form-section" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          className="settings-switch"
          role="switch"
          aria-checked={data?.enabled === true}
          disabled={busy}
          onClick={() => post({ action: data?.enabled ? "disable" : "enable" })}
        >
          {data?.enabled ? t("memory.enabled") : t("memory.disabled")}
        </button>
        <button type="button" className="codex-dialog-button" data-variant="primary" disabled={busy || !data?.enabled} onClick={() => setRememberOpen(true)}>
          {t("memory.remember")}
        </button>
      </div>
      {data?.envOverrides && <p role="status">{t("memory.envOverride")}</p>}
      {error && <div role="alert" className="settings-inline-error">{error}</div>}
      {data?.enabled && (
        <div className="settings-form-section" style={{ display: "grid", gridTemplateColumns: "minmax(12rem, 18rem) 1fr", gap: 12 }}>
          <div>
            {(data.files ?? []).map((file) => (
              <button
                key={file.path}
                type="button"
                className="settings-archived-row"
                onClick={() => load(file.path)}
                style={{ width: "100%", textAlign: "left", background: selected === file.path ? "var(--bg-selected)" : undefined }}
              >
                <span>{file.name}</span>
                {file.scope === "session" && (
                  <button
                    type="button"
                    className="codex-dialog-button"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void post({ action: "delete", path: file.path });
                    }}
                  >
                    {t("memory.delete")}
                  </button>
                )}
              </button>
            ))}
            {data.files.length === 0 && <p>{t("memory.empty")}</p>}
          </div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: "var(--text-meta)" }}>
            {data.preview?.text || t("memory.noPreview")}
          </pre>
        </div>
      )}
      {rememberOpen && (
        <DialogShell
          size="request"
          title={t("memory.remember")}
          onClose={() => setRememberOpen(false)}
          footer={(
            <>
              <button type="button" className="codex-dialog-button" onClick={() => setRememberOpen(false)}>{t("chat.cancel")}</button>
              <button
                type="button"
                className="codex-dialog-button"
                data-variant="primary"
                disabled={busy || !note.trim()}
                onClick={async () => {
                  await post({ action: "remember", text: note.trim() });
                  setNote("");
                  setRememberOpen(false);
                }}
              >
                {t("memory.save")}
              </button>
            </>
          )}
        >
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} style={{ width: "100%" }} />
        </DialogShell>
      )}
    </div>
  );
}
