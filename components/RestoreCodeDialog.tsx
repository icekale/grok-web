"use client";

import { useState } from "react";
import { DialogShell } from "./DialogShell";

export function RestoreCodeDialog({ sessionId, advisoryName, onClose, onSuccess }: { sessionId: string; advisoryName?: string; onClose: () => void; onSuccess: (result: { newSessionId: string; worktreePath: string }) => void }) {
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
  return <DialogShell size="confirm" title="Restore code in new worktree" ariaLabel="Restore code" onClose={() => { if (!busy) onClose(); }} dismissible={!busy} backdropDismissible={false} footer={<><button type="button" className="codex-dialog-button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="codex-dialog-button" data-variant="primary" onClick={() => void restore()} disabled={busy}>Restore</button></>}>
    <p className="codex-dialog-copy">The original project and session remain untouched. A new ACP-owned worktree will be created.</p>
    <code className="codex-dialog-inset">{advisoryName ?? `restore/${sessionId.slice(0, 8)}`}</code>
    {error && <div className="codex-dialog-error" role="alert">{error}</div>}
  </DialogShell>;
}
