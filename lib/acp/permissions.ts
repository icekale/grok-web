import { grokCanonicalToolName, sanitizeGrokToolInput } from "../grok-tool-input.ts";

export type PermissionUiOption = {
  id: string;
  label: string;
  kind: string;
};

export type PermissionUiSnapshot = PermissionUiRequest & {
  sessionId: string;
  expiresAt: number;
};

export type PermissionUiRequest = {
  type: "extension_ui_request";
  id: string;
  method: "confirm";
  title: string;
  message: string;
  options?: PermissionUiOption[];
};

export type PermissionResult =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "rejected" } };

const SUMMARY_KEYS = ["description", "query", "pattern", "url", "glob"] as const;
const PATH_KEYS = ["path", "file_path", "filePath", "target"] as const;

export function translatePermissionRequest(params: unknown, rpcId: number | string): PermissionUiRequest {
  const toolCall = isRecord(params) && isRecord(params.toolCall) ? params.toolCall : {};
  const rawTitle = firstString(toolCall.title);
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const input = sanitizeGrokToolInput(asRecord(toolCall.rawInput ?? toolCall.input));
  const options = translatePermissionOptions(params);
  return {
    type: "extension_ui_request",
    id: String(rpcId),
    method: "confirm",
    title: permissionTitle(rawTitle, kind, input),
    message: permissionMessage(rawTitle, kind, input),
    ...(options ? { options } : {}),
  };
}

function translatePermissionOptions(params: unknown): PermissionUiOption[] | undefined {
  if (!isRecord(params) || !Array.isArray(params.options)) return undefined;
  const options = params.options
    .filter(isRecord)
    .map((option) => {
      const id = optionId(option);
      const label = firstString(option.label, option.name, option.title, id);
      const kind = firstString(option.kind, id);
      return id && label && kind
        ? { id, label: label.slice(0, 200), kind: kind.slice(0, 100) }
        : undefined;
    })
    .filter((option): option is PermissionUiOption => option !== undefined)
    .slice(0, 12);
  return options.length > 0 ? options : undefined;
}

function permissionTitle(title: string, kind: string, input: Record<string, unknown>): string {
  const canonical = grokCanonicalToolName(title, kind).toLowerCase();
  if (canonical === "exit_plan_mode" || /\b(plan|implementation)\b.*\b(approve|approval|review)\b/i.test(title)) return "Approve plan";
  if (isHumanToolTitle(title)) return title;
  const command = commandValue(input);
  if (command && (grokCanonicalToolName(title, kind) === "bash" || !title)) {
    return `Execute \`${firstLine(command)}\``;
  }
  const path = pathValue(input);
  if (path) {
    const verb = writeVerb(title, kind);
    return `${verb} \`${path}\``;
  }
  return firstString(title, kind, grokCanonicalToolName(title, kind), "tool");
}

function permissionMessage(title: string, kind: string, input: Record<string, unknown>): string {
  const canonical = grokCanonicalToolName(title, kind).toLowerCase();
  if (canonical === "exit_plan_mode") return firstString(input.content, input.message, "Review the plan before implementation.");
  const command = commandValue(input);
  if (command) return command;
  const path = pathValue(input);
  if (path) return path;
  const extra = firstString(...SUMMARY_KEYS.map((key) => input[key]));
  const name = grokCanonicalToolName(title, kind) || "tool";
  return extra ? `${name} ${extra}` : name;
}

function isHumanToolTitle(title: string): boolean {
  return title.includes("`") || /^(execute|read|write|edit|search|list)\s/i.test(title);
}

function commandValue(input: Record<string, unknown>): string {
  return firstString(input.command, input.cmd);
}

function pathValue(input: Record<string, unknown>): string {
  return firstString(...PATH_KEYS.map((key) => input[key]));
}

function writeVerb(title: string, kind: string): string {
  const blob = `${title} ${kind}`.toLowerCase();
  if (/\b(write|edit|create)\b/.test(blob)) return "Write";
  return "Read";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
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
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
