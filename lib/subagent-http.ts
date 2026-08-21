import { listAllSessions, resolveSessionPath } from "@/lib/session-reader";
import { findGrokSession } from "@/lib/session-index.ts";
import { listSubagentMetas } from "@/lib/grok-fs/subagent-meta.ts";
import type { SubagentTreeResponse, SubagentControlResponse } from "@/lib/api-types";
import type { SessionInfo } from "@/lib/types";
import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import {
  controlGrokSubagent,
  findGrokChild,
  grokSubagentTree,
  type GrokSubagentTreeExtras,
  type SubagentRuntime,
} from "@/lib/acp/subagents.ts";

// ============================================================================
// GET  /api/agent/[rootId]/subagents
// POST /api/agent/[rootId]/subagents
//
// Root-scoped subagent tree and controls. Tree and control traffic goes through
// AgentRuntime (ACP); rpcAvailable means the ACP session is loaded (or live
// subagent listing succeeded), not a Pi RPC wrapper.
// ============================================================================

export type SubagentHttpRuntime = SubagentRuntime & {
  hasSession?(sessionId: string): boolean;
  listRunningSubagents(sessionId: string): Promise<{ subagents?: GrokSubagentTreeExtras["live"] }>;
};

export interface SubagentRouteDeps {
  listSessions: () => Promise<SessionInfo[]>;
  runtime: SubagentHttpRuntime;
  resolveSessionPath: (id: string) => Promise<string | null>;
}

function resolveDeps(overrides: Partial<SubagentRouteDeps> = {}): SubagentRouteDeps {
  return {
    // The cached session list (30s TTL) is fresh enough for durable tree nodes;
    // forcing a full re-scan on every poll made 1.5s polling rebuild the whole
    // session index (including nested discovery) per tick. Live children still
    // appear instantly from ACP listRunningSubagents.
    listSessions: overrides.listSessions ?? (() => listAllSessions()),
    runtime: overrides.runtime ?? getAgentRuntime(),
    resolveSessionPath: overrides.resolveSessionPath ?? resolveSessionPath,
  };
}

async function listGrokMetas(rootId: string) {
  const grokSession = await findGrokSession(rootId);
  return grokSession ? listSubagentMetas(grokSession.path) : [];
}

async function mergedGrokSubagentTree(
  rootId: string,
  sessions: SessionInfo[],
  runtime: SubagentHttpRuntime,
): Promise<SubagentTreeResponse> {
  const extras: GrokSubagentTreeExtras = {
    metas: await listGrokMetas(rootId),
    live: [],
    rpcAvailable: runtime.hasSession?.(rootId) === true,
  };
  try {
    extras.live = (await runtime.listRunningSubagents(rootId)).subagents ?? [];
    extras.rpcAvailable = true;
  } catch {
    extras.live = [];
  }
  return grokSubagentTree(rootId, sessions, Date.now(), extras);
}

export function createSubagentHandlers(deps: Partial<SubagentRouteDeps> = {}) {
  const resolved = resolveDeps(deps);

  async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    const { id: rootId } = await params;
    try {
      const sessions = await resolved.listSessions();
      const root = sessions.find((session) => session.id === rootId);
      if (!root) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      return Response.json(await mergedGrokSubagentTree(rootId, sessions, resolved.runtime));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    const { id: rootId } = await params;
    try {
      const body = await req.json() as {
        childSessionId?: unknown;
        action?: unknown;
        message?: unknown;
      };
      const action = body.action;
      if (action !== "steer" && action !== "interrupt" && action !== "resume") {
        return Response.json({ error: "Unsupported subagent control action" }, { status: 400 });
      }
      if (typeof body.childSessionId !== "string" || body.childSessionId.length === 0) {
        return Response.json({ error: "childSessionId is required" }, { status: 400 });
      }
      if (action === "interrupt") {
        if (body.message !== undefined && body.message !== null && String(body.message).trim().length > 0) {
          return Response.json({ error: "interrupt does not accept a message" }, { status: 400 });
        }
      } else if (typeof body.message !== "string" || body.message.trim().length === 0) {
        return Response.json({ error: `${action} requires a non-empty message` }, { status: 400 });
      }

      const sessions = await resolved.listSessions();
      const metas = await listGrokMetas(rootId);
      const child = findGrokChild(rootId, body.childSessionId, sessions, metas);
      if (!child) {
        return Response.json({ error: "Child session does not belong to this root" }, { status: 400 });
      }
      try {
        const data = await controlGrokSubagent(
          resolved.runtime,
          rootId,
          body.childSessionId,
          action,
          typeof body.message === "string" ? body.message : undefined,
          { subagentId: child.subagentRunId },
        );
        return Response.json({
          success: true,
          data: {
            action: data.action,
            childSessionId: data.childSessionId,
            tree: await mergedGrokSubagentTree(rootId, sessions, resolved.runtime),
          },
        } satisfies SubagentControlResponse);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (action === "resume") {
          return Response.json({ error: message }, { status: 400 });
        }
        throw error;
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  return { GET, POST };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return createSubagentHandlers().GET(req, ctx);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return createSubagentHandlers().POST(req, ctx);
}
