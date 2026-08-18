import { existsSync } from "node:fs";
import { toSlashPath } from "../paths.ts";
import { nextPromptGeneration } from "../prompt-generation.ts";
import { findGrokSession } from "../session-index.ts";
import { invalidateSessionListCache } from "../session-reader.ts";
import { formatGrokMissingError } from "./process.ts";
import type { AgentCommand, AgentRuntime } from "./runtime.ts";

type AgentBody = {
  cwd?: unknown;
  type?: unknown;
  [key: string]: unknown;
};

type SessionState = {
  model?: { provider?: unknown; id?: unknown };
  thinkingLevel?: unknown;
};

export function createAgentHandlers(runtime: AgentRuntime): {
  postNew(req: Request): Promise<Response>
  postSession(req: Request, id: string): Promise<Response>
  getSession(req: Request, id: string): Promise<Response>
  getRunning(): Promise<Response>
} {
  return {
    async postNew(req: Request): Promise<Response> {
      let commandType: string | undefined;
      let promptAccepted = false;
      try {
        const body = await req.json() as AgentBody;
        const { cwd, ...command } = body;
        commandType = typeof command.type === "string" ? command.type : undefined;

        if (!cwd || typeof cwd !== "string") {
          return Response.json({
            error: "cwd is required",
            ...(commandType === "prompt"
              ? { code: "prompt_rejected", accepted: false }
              : {}),
          }, { status: 400 });
        }
        if (!existsSync(cwd)) {
          return Response.json({
            error: `Directory does not exist: ${cwd}`,
            ...(commandType === "prompt"
              ? { code: "prompt_rejected", accepted: false }
              : {}),
          }, { status: 400 });
        }

        const sessionId = await runtime.createSession(cwd);
        allowFileRoot(cwd);
        invalidateSessionListCache();

        const state = await runtime.send(sessionId, { type: "get_state" }) as SessionState;
        const model = publicModel(state);
        const thinkingLevel = state.thinkingLevel;

        if (command.type === "ensure_session") {
          return Response.json({
            success: true,
            sessionId,
            data: null,
            model,
            thinkingLevel,
          });
        }

        if (command.type === "prompt") {
          await runtime.send(sessionId, command as AgentCommand);
          promptAccepted = true;
          return Response.json({
            success: true,
            sessionId,
            data: { promptGeneration: nextPromptGeneration(sessionId) },
            model,
            thinkingLevel,
          });
        }

        const result = await runtime.send(sessionId, command as AgentCommand);
        return Response.json({
          success: true,
          sessionId,
          data: result,
          model,
          thinkingLevel,
        });
      } catch (error) {
        return agentErrorResponse(error, {
          commandType,
          promptAccepted,
        });
      }
    },

    async postSession(req: Request, id: string): Promise<Response> {
      let commandType: string | undefined;
      let promptAccepted = false;
      try {
        const command = await req.json() as AgentCommand;
        commandType = typeof command.type === "string" ? command.type : undefined;

        if (command.type !== "get_state") {
          await loadSessionIfNeeded(runtime, id);
        }

        if (command.type === "prompt") {
          await runtime.send(id, command);
          promptAccepted = true;
          return Response.json({
            success: true,
            data: { promptGeneration: nextPromptGeneration(id) },
          });
        }

        const result = await runtime.send(id, command);
        return Response.json({ success: true, data: result });
      } catch (error) {
        return agentErrorResponse(error, {
          commandType,
          promptAccepted,
        });
      }
    },

    async getSession(_req: Request, id: string): Promise<Response> {
      try {
        const state = await runtime.send(id, { type: "get_state" });
        return Response.json({ running: runtime.isBusy(id), state });
      } catch (error) {
        return agentErrorResponse(error);
      }
    },

    async getRunning(): Promise<Response> {
      return Response.json(
        { runningSessionIds: runtime.listBusyIds() },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
  };
}

function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = toSlashPath(root);
  const extra = globalThis.__piAdditionalAllowedRoots ??= new Set<string>();
  extra.add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
}

async function loadSessionIfNeeded(runtime: AgentRuntime, id: string): Promise<void> {
  const session = await findGrokSession(id);
  if (!session) return;
  try {
    await runtime.loadSession(id, session.cwd);
  } catch (error) {
    if (errorMessage(error).includes("already loaded")) return;
    throw error;
  }
}

function publicModel(state: SessionState): { provider: string; modelId: string } | null {
  if (typeof state.model?.provider !== "string" || typeof state.model?.id !== "string") {
    return null;
  }
  return { provider: state.model.provider, modelId: state.model.id };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGrokMissing(error: unknown): boolean {
  return errorMessage(error).includes("grok-missing");
}

function formatHandlerError(error: unknown): string {
  return isGrokMissing(error) ? formatGrokMissingError() : errorMessage(error);
}

function agentErrorResponse(
  error: unknown,
  extras: { commandType?: string; promptAccepted?: boolean } = {},
): Response {
  const status = isGrokMissing(error) ? 503 : 500;
  return Response.json({
    error: formatHandlerError(error),
    ...(extras.commandType === "prompt" && !extras.promptAccepted
      ? { code: "prompt_rejected", accepted: false }
      : {}),
  }, { status });
}
