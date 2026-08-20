import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryMessage } from "./history-map.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function messageHtml(message: HistoryMessage): string {
  if (message.role === "user") {
    return `<section class="user"><h2>User</h2><pre>${escapeHtml(message.content)}</pre></section>`;
  }
  if (message.role === "toolResult") {
    const text = message.content.map((part) => part.text).join("\n");
    return `<section class="tool-result"><h2>Tool result</h2><pre>${escapeHtml(text)}</pre></section>`;
  }
  const parts = message.content.map((part) => {
    if (part.type === "text") return `<p>${escapeHtml(part.text)}</p>`;
    if (part.type === "thinking") return `<details><summary>Thinking</summary><pre>${escapeHtml(part.thinking)}</pre></details>`;
    return `<p class="tool">${escapeHtml(part.toolName)}</p>`;
  }).join("");
  return `<section class="assistant"><h2>Grok</h2>${parts}</section>`;
}

export function renderSessionHtml(title: string, messages: HistoryMessage[]): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#111}
pre{white-space:pre-wrap;word-break:break-word}section{margin:1.5rem 0}</style>
</head><body><h1>${escapeHtml(title)}</h1>
${messages.map(messageHtml).join("\n")}
</body></html>
`;
}

export function packSessionArchive(sessionDir: string, sessionId: string): { fileName: string; bytes: Buffer } {
  const scratch = mkdtempSync(join(tmpdir(), "grok-session-zip-"));
  const zipPath = join(scratch, `${sessionId}.zip`);
  try {
    execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: sessionDir });
    return {
      fileName: `grok-session-${sessionId}.zip`,
      bytes: readFileSync(zipPath),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
