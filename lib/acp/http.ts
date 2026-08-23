import { existsSync } from "node:fs";
import { toSlashPath } from "../paths.ts";
import { nextPromptGeneration } from "../prompt-generation.ts";
import { findGrokSession } from "../session-index.ts";
import { invalidateSessionListCache } from "../session-reader.ts";
import { hasJsonContentType } from "../request-security.ts";
import { formatGrokMissingError } from "./process.ts";
import { AgentCapabilityError, AgentCommandError, type AgentCommand, type AgentRuntime } from "./runtime.ts";

type AgentBody = {
  cwd?: unknown;
  type?: unknown;
  [key: string]: unknown;
};

type SessionState = {
  model?: { provider?: unknown; id?: unknown };
  thinkingLevel?: unknown;
  modes?: unknown;
};

export function createAgentHandlers(runtime: AgentRuntime): {
  postNew(req: Request): Promise<Response>
  postSession(req: Request, id: string): Promise<Response>
  getSession(req: Request, id: string): Promise<Response>
  getRunning(): Promise<Response>
} {
  return {
    async postNew(req: Request): Promise<Response> {
      if (!hasJsonContentType(req)) {
        return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
      }
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
        if (Array.isArray(body.toolNames)) {
          try {
            await runtime.send(sessionId, { type: "set_tools", toolNames: body.toolNames });
          } catch (error) {
            if (!(error instanceof AgentCapabilityError)) throw error;
          }
        }

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
            modes: state.modes,
          });
        }

        if (command.type === "prompt") {
          const promptGeneration = nextPromptGeneration(sessionId);
          await runtime.send(sessionId, { ...command, promptGeneration } as AgentCommand);
          promptAccepted = true;
          return Response.json({
            success: true,
            sessionId,
            data: { promptGeneration },
            model,
            thinkingLevel,
            modes: state.modes,
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
      if (!hasJsonContentType(req)) {
        return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
      }
      let commandType: string | undefined;
      let promptAccepted = false;
      try {
        const command = await req.json() as AgentCommand;
        commandType = typeof command.type === "string" ? command.type : undefined;

        if (command.type !== "get_state") {
          await loadSessionIfNeeded(runtime, id);
        }
        if (!runtime.hasSession(id)) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }

        if (command.type === "prompt") {
          const promptGeneration = nextPromptGeneration(id);
          await runtime.send(id, { ...command, promptGeneration });
          promptAccepted = true;
          return Response.json({
            success: true,
            data: { promptGeneration },
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
        await loadSessionIfNeeded(runtime, id);
        if (!runtime.hasSession(id)) {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }
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
  if (runtime.hasSession(id)) return;
  const session = await findGrokSession(id);
  if (!session) return;
  try {
    await runtime.loadSession(id, session.cwd);
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("already loaded")) return;
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
  const status = isGrokMissing(error)
    ? 503
    : error instanceof AgentCommandError
      ? error.status
    : error instanceof AgentCapabilityError || (error as { status?: unknown }).status === 501
      ? 501
    : 500;
  return Response.json({
    error: formatHandlerError(error),
    ...(error instanceof AgentCommandError ? { code: error.code } : {}),
    ...(extras.commandType === "prompt" && !extras.promptAccepted
      ? { code: "prompt_rejected", accepted: false }
      : {}),
  }, { status });
}
