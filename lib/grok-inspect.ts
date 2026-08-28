import { execFile as nodeExecFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { formatGrokMissingError, resolveGrokBin } from "./acp/process.ts";
import { grokHome } from "./grok-home.ts";

const execFileDefault = promisify(nodeExecFile);

export type GrokInspectHook = {
  event: string;
  hookType: string;
  target: string;
  matcher: string | null;
  sourceType: string;
  pluginName?: string;
  sourcePath?: string;
  removable: boolean;
};

export type GrokInspectSnapshot = {
  projectTrusted: boolean;
  projectRoot: string | null;
  folderTrustEnabled?: boolean;
  hooks: GrokInspectHook[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userHooksDir(home = grokHome()): string {
  return join(home, "hooks");
}

function isRemovableTarget(target: string, home = grokHome()): boolean {
  if (!target || target.includes("://")) return false;
  try {
    const resolved = realpathSync(target);
    const root = realpathSync(userHooksDir(home));
    return resolved === root || resolved.startsWith(root + sep);
  } catch {
    const root = userHooksDir(home);
    return target === root || target.startsWith(root + sep);
  }
}

export function parseGrokInspect(value: unknown, home = grokHome()): GrokInspectSnapshot {
  if (!isRecord(value)) {
    return { projectTrusted: false, projectRoot: null, hooks: [] };
  }
  const projectRoot = typeof value.projectRoot === "string" && value.projectRoot ? value.projectRoot : null;
  const projectTrusted = value.projectTrusted === true;
  const folderTrustEnabled = typeof value.folderTrustEnabled === "boolean" ? value.folderTrustEnabled : undefined;
  const rawHooks = Array.isArray(value.hooks) ? value.hooks : [];
  const hooks: GrokInspectHook[] = [];
  for (const row of rawHooks) {
    if (!isRecord(row) || typeof row.event !== "string" || !row.event) continue;
    const source = isRecord(row.source) ? row.source : {};
    const target = typeof row.target === "string" ? row.target : "";
    const sourceType = typeof source.type === "string" && source.type ? source.type : "unknown";
    hooks.push({
      event: row.event,
      hookType: typeof row.hookType === "string" ? row.hookType : "",
      target,
      matcher: typeof row.matcher === "string" ? row.matcher : null,
      sourceType,
      ...(typeof source.plugin_name === "string" ? { pluginName: source.plugin_name } : {}),
      ...(typeof source.path === "string" ? { sourcePath: source.path } : {}),
      removable: sourceType !== "plugin" && isRemovableTarget(target, home),
    });
  }
  return {
    projectTrusted,
    projectRoot,
    ...(folderTrustEnabled !== undefined ? { folderTrustEnabled } : {}),
    hooks,
  };
}

type ExecFile = (
  file: string,
  args: string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout?: string; stderr?: string }>;

export async function runGrokInspect(
  cwd: string,
  deps: { execFile?: ExecFile; resolveBin?: () => string; home?: string } = {},
): Promise<GrokInspectSnapshot> {
  const execFile = deps.execFile ?? (async (file, args, options) => execFileDefault(file, args, options as never) as never);
  let bin: string;
  try {
    bin = deps.resolveBin ? deps.resolveBin() : resolveGrokBin();
  } catch {
    throw new Error(formatGrokMissingError());
  }
  const home = deps.home ?? grokHome();
  try {
    const output = await execFile(bin, ["inspect", "--json"], {
      cwd,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GROK_HOME: home },
    });
    const stdout = typeof output.stdout === "string" ? output.stdout : "";
    return parseGrokInspect(JSON.parse(stdout), home);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("grok-missing:")) throw error;
    throw new Error(`grok inspect failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
