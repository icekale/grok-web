import { mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { join, sep } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { grokHome } from "./grok-home.ts";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type UserHookInput = {
  event: string;
  type: "command" | "http";
  command?: string;
  url?: string;
  matcher?: string;
  timeout?: number;
};

function userHooksDir(home = grokHome()): string {
  return join(home, "hooks");
}

function assertHookEvent(event: string): asserts event is HookEvent {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    throw new Error(`Unsupported hook event: ${event}`);
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || isIP(host) === 4 && host.startsWith("127.");
  } catch {
    return false;
  }
}

function handlerFromInput(input: UserHookInput): Record<string, unknown> {
  if (input.type === "command") {
    const command = input.command?.trim() ?? "";
    if (!command) throw new Error("command is required");
    const handler: Record<string, unknown> = { type: "command", command };
    if (typeof input.timeout === "number" && Number.isInteger(input.timeout) && input.timeout > 0) {
      handler.timeout = input.timeout;
    }
    return handler;
  }
  const url = input.url?.trim() ?? "";
  if (!url) throw new Error("url is required");
  if (!url.startsWith("https:") && !isLoopbackUrl(url)) {
    throw new Error("http hooks must use https or loopback");
  }
  const handler: Record<string, unknown> = { type: "http", url };
  if (typeof input.timeout === "number" && Number.isInteger(input.timeout) && input.timeout > 0) {
    handler.timeout = input.timeout;
  }
  return handler;
}

export function renderUserHookFile(input: UserHookInput): string {
  assertHookEvent(input.event);
  const group: Record<string, unknown> = { hooks: [handlerFromInput(input)] };
  const matcher = input.matcher?.trim();
  if (matcher) group.matcher = matcher;
  return `${JSON.stringify({ hooks: { [input.event]: [group] } }, null, 2)}\n`;
}

export function addUserHook(input: UserHookInput, home = grokHome()): string {
  const dir = userHooksDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const slug = `web-${input.event.toLowerCase()}-${randomBytes(4).toString("hex")}.json`;
  const path = join(dir, slug);
  writePrivateFileAtomicSync(path, renderUserHookFile(input));
  return path;
}

export function removeUserHook(target: string, home = grokHome()): void {
  let resolved: string;
  let root: string;
  try {
    resolved = realpathSync(target);
    root = realpathSync(userHooksDir(home));
  } catch {
    throw new Error("Hook path is outside ~/.grok/hooks");
  }
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error("Hook path is outside ~/.grok/hooks");
  }
  unlinkSync(resolved);
}
