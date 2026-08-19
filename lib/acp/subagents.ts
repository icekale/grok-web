import type { SubagentLifecycleState, SubagentTreeNode, SubagentTreeResponse } from "../api-types.ts";
import type { GrokSubagentMeta } from "../grok-fs/subagent-meta.ts";
import { attachSessionRelations } from "../session-relations.ts";
import type { SessionInfo } from "../types.ts";
import type { AgentRuntime } from "./runtime.ts";

export type SubagentRuntime = {
  send: AgentRuntime["send"];
  cancelSubagent?: (subagentId: string) => Promise<unknown>;
};

type LiveSubagentRow = {
  subagentId?: string;
  id?: string;
  childSessionId?: string;
  description?: string;
  status?: string;
  subagentType?: string;
  agentType?: string;
};

export type GrokSubagentTreeExtras = {
  metas?: GrokSubagentMeta[];
  live?: LiveSubagentRow[];
  rpcAvailable?: boolean;
};

export function findGrokChild(
  rootId: string,
  childSessionId: string,
  sessions: SessionInfo[],
): SessionInfo | null {
  if (childSessionId === rootId) return null;
  const related = attachSessionRelations(sessions);
  const child = related.find((session) => session.id === childSessionId);
  if (!child) return null;
  if (child.rootSessionId === rootId || child.parentSessionId === rootId) return child;
  return null;
}

export function mapDiskStatus(status: string): SubagentLifecycleState {
  if (status === "completed") return "complete";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  if (status === "running" || status === "starting") return "running";
  return "inactive";
}

function liveRowId(row: LiveSubagentRow): string | undefined {
  return row.subagentId || row.id || row.childSessionId;
}

function treeResponse(
  rootId: string,
  nodes: SubagentTreeNode[],
  now: number,
  rpcAvailable: boolean,
): SubagentTreeResponse {
  return {
    rootSessionId: rootId,
    rpcAvailable,
    ...(rpcAvailable ? {} : { unavailableReason: "offline" as const }),
    nodes,
    polledAt: now,
  };
}

export function grokSubagentTreeFromSessions(
  rootId: string,
  sessions: SessionInfo[],
  now = Date.now(),
  rpcAvailable = false,
): SubagentTreeResponse {
  const related = attachSessionRelations(sessions);
  const children = related.filter((session) => (
    session.id !== rootId
    && (session.rootSessionId === rootId || session.parentSessionId === rootId)
  ));
  const nodes: SubagentTreeNode[] = children.map((session) => ({
    sessionId: session.id,
    parentSessionId: session.parentSessionId ?? rootId,
    runId: session.subagentRunId ?? session.id,
    ...(session.subagentIndex !== undefined ? { index: session.subagentIndex } : {}),
    agent: session.subagentAgent ?? "grok",
    task: session.name ?? session.firstMessage,
    state: "inactive",
    canSteer: true,
    canInterrupt: true,
    canResume: false,
    children: [],
  }));
  return treeResponse(rootId, nodes, now, rpcAvailable);
}

export function grokSubagentTree(
  rootId: string,
  sessions: SessionInfo[],
  now = Date.now(),
  extras: GrokSubagentTreeExtras = {},
): SubagentTreeResponse {
  const liveById = new Map<string, LiveSubagentRow>();
  for (const row of extras.live ?? []) {
    const id = liveRowId(row);
    if (id) liveById.set(id, row);
  }
  const fromMeta = (extras.metas ?? []).map((meta) => {
    const live = liveById.get(meta.subagentId) ?? liveById.get(meta.childSessionId);
    const liveId = live ? liveRowId(live) : undefined;
    if (liveId) liveById.delete(liveId);
    const running = Boolean(live);
    return {
      sessionId: meta.childSessionId,
      parentSessionId: meta.parentSessionId || rootId,
      runId: meta.subagentId,
      agent: live?.subagentType || live?.agentType || meta.agent,
      task: live?.description || meta.task,
      state: running ? "running" as const : mapDiskStatus(meta.status),
      canSteer: running,
      canInterrupt: running,
      canResume: false,
      children: [],
    };
  });
  const leftovers = [...liveById.values()].map((live) => {
    const id = liveRowId(live) || "live";
    return {
      sessionId: live.childSessionId || id,
      parentSessionId: rootId,
      runId: id,
      agent: live.subagentType || live.agentType || "grok",
      task: live.description || "",
      state: "running" as const,
      canSteer: true,
      canInterrupt: true,
      canResume: false,
      children: [],
    };
  });
  const nodes = [...fromMeta, ...leftovers];
  if (nodes.length === 0) {
    return grokSubagentTreeFromSessions(rootId, sessions, now, extras.rpcAvailable === true);
  }
  return treeResponse(rootId, nodes, now, extras.rpcAvailable === true);
}

export async function controlGrokSubagent(
  runtime: SubagentRuntime,
  rootId: string,
  childSessionId: string,
  action: "steer" | "interrupt" | "resume",
  message?: string,
): Promise<{ action: string; childSessionId: string; rootSessionId: string }> {
  if (action === "steer") {
    await runtime.send(rootId, {
      type: "prompt",
      message: message ?? "",
      streamingBehavior: "steer",
    });
  } else if (action === "interrupt") {
    if (!runtime.cancelSubagent) {
      throw new Error("Subagent cancel is not available");
    }
    await runtime.cancelSubagent(childSessionId);
  } else {
    throw new Error("Subagent resume is not supported");
  }
  return { action, childSessionId, rootSessionId: rootId };
}
