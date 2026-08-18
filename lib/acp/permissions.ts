export type PermissionUiRequest = {
  type: "extension_ui_request";
  id: string;
  method: "confirm";
  title: string;
  message: string;
};

export type PermissionResult =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "rejected" } };

export function translatePermissionRequest(params: unknown, rpcId: number): PermissionUiRequest {
  const toolCall = isRecord(params) && isRecord(params.toolCall) ? params.toolCall : {};
  const title = firstString(toolCall.title, toolCall.kind, "tool");
  const input = toolCall.rawInput ?? toolCall.input ?? {};
  return {
    type: "extension_ui_request",
    id: String(rpcId),
    method: "confirm",
    title: "Allow tool",
    message: `${title} ${JSON.stringify(input)}`,
  };
}

export function resolvePermission(
  ui: { confirmed?: boolean; cancelled?: boolean },
  request: unknown,
  timing?: { startedAt: number; now: number; timeoutMs?: number },
): PermissionResult {
  const timedOut = timing != null && permissionTimedOut(timing.startedAt, timing.now, timing.timeoutMs);
  if (timedOut || ui.cancelled || ui.confirmed !== true) {
    return { outcome: { outcome: "rejected" } };
  }
  return { outcome: { outcome: "selected", optionId: allowOptionId(request) } };
}

export function permissionTimedOut(startedAt: number, now: number, timeoutMs = 60_000): boolean {
  return now - startedAt >= timeoutMs;
}

function allowOptionId(request: unknown): string {
  const options = isRecord(request) && Array.isArray(request.options) ? request.options : [];
  const items = options.filter(isRecord);
  const byId = items.find((option) => {
    const id = optionId(option);
    return id === "allow-once" || id === "allow_once";
  });
  if (byId) return optionId(byId) ?? "allow-once";
  const byNameKind = items.find((option) => {
    const name = typeof option.name === "string" ? option.name : "";
    const kind = typeof option.kind === "string" ? option.kind : "";
    return name.toLowerCase().includes("allow") || kind.toLowerCase().includes("allow");
  });
  return (byNameKind && optionId(byNameKind)) || "allow-once";
}

function optionId(option: Record<string, unknown>): string | undefined {
  if (typeof option.optionId === "string") return option.optionId;
  if (typeof option.id === "string") return option.id;
  return undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
