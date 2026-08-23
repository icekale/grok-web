export type AcpPlanStatus = "pending" | "in_progress" | "completed";

export type AcpPlan = {
  entries: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: AcpPlanStatus;
  }>;
};

export function readAcpPlanUpdate(value: unknown): AcpPlan | null {
  if (!isRecord(value) || value.sessionUpdate !== "plan" || !isRecord(value.plan) || !Array.isArray(value.plan.entries)) return null;
  const entries = [] as AcpPlan["entries"];
  for (const entry of value.plan.entries) {
    if (!isRecord(entry) || typeof entry.content !== "string") return null;
    const priority = entry.priority === "high" || entry.priority === "medium" || entry.priority === "low"
      ? entry.priority
      : "medium";
    const status = entry.status === "pending" || entry.status === "in_progress" || entry.status === "completed"
      ? entry.status
      : null;
    if (!status) return null;
    entries.push({ content: entry.content, priority, status });
  }
  return { entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
