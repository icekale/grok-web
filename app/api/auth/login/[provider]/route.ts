import { randomBytes } from "node:crypto";
import { getAgentRuntime } from "@/lib/acp/runtime.ts";
import { invalidateModelsCache } from "@/lib/models-cache";

declare global {
  var __piLoginCallbacks: Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }> | undefined;
}

function getCallbackRegistry() {
  if (!globalThis.__piLoginCallbacks) globalThis.__piLoginCallbacks = new Map();
  return globalThis.__piLoginCallbacks;
}

function deviceUserCode(authUrl: string): string | undefined {
  try {
    return new URL(authUrl).searchParams.get("user_code") ?? undefined;
  } catch {
    const match = /[?&]user_code=([^&]+)/.exec(authUrl);
    return match ? decodeURIComponent(match[1]) : undefined;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };

  if (!token || !code) {
    return Response.json({ error: "token and code required" }, { status: 400 });
  }

  const registry = getCallbackRegistry();
  const callbacks = registry.get(token);
  if (!callbacks) {
    return Response.json({ error: "No pending login for token" }, { status: 404 });
  }
  if (!token.startsWith(`${provider}-`)) {
    return Response.json({ error: "Token does not match provider" }, { status: 400 });
  }

  await getAgentRuntime().authSubmitCode(code);
  callbacks.resolve(code);
  registry.delete(token);
  return Response.json({ ok: true, provider });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, data: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream({
    async start(controller) {
      if (provider !== "grok.com") {
        send(controller, { type: "error", message: `Unknown provider: ${provider}` });
        controller.close();
        return;
      }

      const registry = getCallbackRegistry();
      const token = `${provider}-${Date.now()}-${randomBytes(16).toString("hex")}`;
      const cleanup = () => {
        registry.get(token)?.reject(new Error("Login cancelled"));
        registry.delete(token);
      };
      registry.set(token, {
        resolve: () => {
          registry.delete(token);
        },
        reject: () => {
          registry.delete(token);
        },
      });

      abort.signal.addEventListener("abort", () => {
        cleanup();
        void getAgentRuntime().authCancel().catch(() => {});
      });

      try {
        const started = await getAgentRuntime().authGetUrl();
        send(controller, {
          type: "auth",
          url: started.auth_url,
          instructions: null,
          token,
        });
        if (started.mode === "device") {
          send(controller, {
            type: "device_code",
            userCode: deviceUserCode(started.auth_url) ?? "",
            verificationUri: started.auth_url,
            intervalSeconds: 2,
            expiresInSeconds: null,
          });
        }

        while (!abort.signal.aborted) {
          const status = await getAgentRuntime().authCheck();
          if (status.authenticated === true) {
            invalidateModelsCache();
            send(controller, { type: "success" });
            return;
          }
          await wait(2000, abort.signal);
        }
        send(controller, { type: "cancelled" });
      } catch (err) {
        if (abort.signal.aborted) {
          send(controller, { type: "cancelled" });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          send(controller, { type: "error", message: msg });
        }
      } finally {
        cleanup();
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
