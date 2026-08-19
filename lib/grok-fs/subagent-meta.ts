import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type GrokSubagentMeta = {
  subagentId: string;
  parentSessionId: string;
  childSessionId: string;
  agent: string;
  task: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function listSubagentMetas(parentSessionDir: string): GrokSubagentMeta[] {
  const root = join(parentSessionDir, "subagents");
  if (!existsSync(root)) return [];
  const out: GrokSubagentMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "meta.json");
    if (!existsSync(file)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const rec = parsed as Record<string, unknown>;
      const subagentId = asString(rec.subagent_id) || entry.name;
      out.push({
        subagentId,
        parentSessionId: asString(rec.parent_session_id),
        childSessionId: asString(rec.child_session_id) || subagentId,
        agent: asString(rec.subagent_type) || "grok",
        task: asString(rec.description) || asString(rec.prompt),
        status: asString(rec.status) || "inactive",
        ...(asString(rec.started_at) ? { startedAt: asString(rec.started_at) } : {}),
        ...(asString(rec.completed_at) ? { completedAt: asString(rec.completed_at) } : {}),
      });
    } catch {
      // skip a damaged meta
    }
  }
  return out;
}
