"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DialogShell } from "./DialogShell";

export function RestoreCodeDialog({ sessionId, advisoryName, onClose, onSuccess }: { sessionId: string; advisoryName?: string; onClose: () => void; onSuccess: (result: { newSessionId: string; worktreePath: string }) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore-code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      const body = await response.json();
      if (!response.ok || body.status !== "created") throw new Error(body.error || `HTTP ${response.status}`);
      onSuccess(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return (
    <DialogShell
      size="confirm"
      title={t("sidebar.restoreCodeInWorktree")}
      ariaLabel={t("sidebar.restoreCode")}
      onClose={() => { if (!busy) onClose(); }}
      dismissible={!busy}
      backdropDismissible={false}
      footer={(
        <>
          <button type="button" className="codex-dialog-button" onClick={onClose} disabled={busy}>{t("sidebar.cancel")}</button>
          <button type="button" className="codex-dialog-button" data-variant="primary" onClick={() => void restore()} disabled={busy}>{t("sidebar.restoreCode")}</button>
        </>
      )}
    >
      <p className="codex-dialog-copy">{t("sidebar.restoreCodeCopy")}</p>
      <code className="codex-dialog-inset">{advisoryName ?? `restore/${sessionId.slice(0, 8)}`}</code>
      {error && <div className="codex-dialog-error" role="alert">{error}</div>}
    </DialogShell>
  );
}
