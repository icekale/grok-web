import { attachSessionRelations } from "../session-relations.ts";
import type { SessionInfo } from "../types.ts";
import type { SubagentTreeNode, SubagentTreeResponse } from "../api-types.ts";
import type { AgentRuntime } from "./runtime.ts";

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

export function grokSubagentTree(rootId: string, sessions: SessionInfo[], now = Date.now()): SubagentTreeResponse {
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
  return {
    rootSessionId: rootId,
    rpcAvailable: false,
    unavailableReason: "offline",
    nodes,
    polledAt: now,
  };
}

export async function controlGrokSubagent(
  runtime: AgentRuntime,
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
    await runtime.send(rootId, { type: "abort" });
  } else {
    await runtime.send(rootId, { type: "prompt", message: message ?? "" });
  }
  return { action, childSessionId, rootSessionId: rootId };
}
