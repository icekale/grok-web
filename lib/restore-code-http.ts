import { existsSync, realpathSync } from "node:fs";
import { findGrokSession } from "./session-index.ts";
import { getAgentRuntime } from "./acp/runtime.ts";
import { discoverGrokCapabilities } from "./grok-capabilities.ts";
import { resolveGrokBin } from "./acp/process.ts";

type RestoreRecord = Record<string, unknown>;
type RestoreDeps = {
  findSession?: (id: string) => Promise<RestoreRecord | null>;
  readCapabilities?: () => Promise<{ globalFlags: Set<string> }>;
  listWorktrees?: () => Promise<unknown>;
  createWorktree?: (sessionId: string, sourcePath: string) => Promise<{ worktreePath?: string }>;
  forkIntoCwd?: (sessionId: string, sourceCwd: string, newCwd: string) => Promise<{ newSessionId: string }>;
  removeWorktree?: (path: string) => Promise<unknown>;
  trustedRoots?: string[];
};

function errorResponse(error: unknown): Response {
  const value = error && typeof error === "object" ? error as RestoreRecord : {};
  const status = typeof value.status === "number" ? value.status : 400;
  const code = typeof value.code === "string" ? value.code : "restore_invalid";
  return Response.json({ error: error instanceof Error ? error.message : String(error), code }, { status });
}
function unsupported(message: string): never {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = 501; error.code = "unsupported"; throw error;
}
function inside(target: string, roots: string[]): boolean {
  try {
    const resolved = realpathSync(target);
    return roots.some((root) => {
      const base = realpathSync(root);
      return resolved === base || resolved.startsWith(`${base}/`);
    });
  } catch { return false; }
}
function worktreeRows(value: unknown): Array<{ path?: string; branch?: string }> {
  if (Array.isArray(value)) return value as Array<{ path?: string; branch?: string }>;
  if (value && typeof value === "object" && Array.isArray((value as RestoreRecord).worktrees)) return (value as RestoreRecord).worktrees as Array<{ path?: string; branch?: string }>;
  return [];
}

export async function preflightRestoreCode(sessionId: string, deps: RestoreDeps = {}) {
  const session = await (deps.findSession ?? findGrokSession)(sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { status: 404, code: "session_not_found" });
  const metadata = session as RestoreRecord;
  const sourceCwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
  const gitRoot = typeof metadata.git_root_dir === "string" ? metadata.git_root_dir : typeof metadata.projectRoot === "string" ? metadata.projectRoot : sourceCwd;
  const headCommit = metadata.head_commit ?? metadata.headCommit;
  if (!sourceCwd || !gitRoot || !headCommit || !existsSync(sourceCwd)) throw Object.assign(new Error("Historical session lacks Git restore metadata"), { status: 400, code: "restore_metadata_missing" });
  if (!inside(sourceCwd, [...(deps.trustedRoots ?? []), gitRoot])) throw Object.assign(new Error("Restore path is not trusted"), { status: 403, code: "restore_path_untrusted" });
  const capabilities = await (deps.readCapabilities ?? (async () => discoverGrokCapabilities(resolveGrokBin())))();
  if (!capabilities.globalFlags.has("--restore-code") || !capabilities.globalFlags.has("--worktree")) unsupported("Grok restore-code/worktree is not supported");
  let rows;
  try { rows = worktreeRows(await (deps.listWorktrees ?? (() => getAgentRuntime().worktreeList()))()); } catch { unsupported("ACP worktree listing is not supported"); }
  const advisoryName = `restore/${sessionId.slice(0, 8)}`;
  if (rows.some((row) => row.branch === advisoryName || row.path?.endsWith(`/${advisoryName}`))) throw Object.assign(new Error("Restore worktree already exists"), { status: 409, code: "worktree_conflict" });
  return { sessionId, sourceCwd, gitRoot, headCommit, advisoryName, worktrees: rows };
}

export function createRestoreCodeHandlers(deps: RestoreDeps = {}) {
  return {
    async POST(request: Request, params: { id: string }) {
      try {
        const body = await request.json().catch(() => ({})) as RestoreRecord;
        const preflight = await preflightRestoreCode(params.id, deps);
        if (body.confirm !== true) return Response.json({ status: "confirmation_required", ...preflight });
        const create = deps.createWorktree ?? ((id: string, source: string) => getAgentRuntime().worktreeCreate(id, source));
        const fork = deps.forkIntoCwd ?? ((id: string, source: string, cwd: string) => getAgentRuntime().forkSessionIntoCwd(id, source, cwd));
        const created = await create(params.id, preflight.sourceCwd);
        const worktreePath = created.worktreePath;
        if (!worktreePath || !inside(worktreePath, [preflight.gitRoot])) throw Object.assign(new Error(`ACP returned an unsafe worktree path: ${worktreePath ?? "missing"}`), { status: 400, code: "restore_path_untrusted", residualPath: worktreePath });
        const forked = await fork(params.id, preflight.sourceCwd, realpathSync(worktreePath));
        return Response.json({ status: "created", ...preflight, worktreePath, newSessionId: forked.newSessionId });
      } catch (error) { return errorResponse(error); }
    },
  };
}
