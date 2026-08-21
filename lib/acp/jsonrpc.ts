import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createInterface, type Interface } from "node:readline";

export type JsonRpcId = number | string;

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

export class JsonRpcConnectionClosedError extends Error {
  readonly code = "ACP_JSONRPC_CLOSED";

  constructor(cause?: unknown) {
    super("ACP JSON-RPC connection closed", { cause });
    this.name = "JsonRpcConnectionClosedError";
  }
}

export class JsonRpcConn {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly notes = new EventEmitter();
  private readonly lifecycle = new EventEmitter();
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly reader: Interface;
  private closedError: JsonRpcConnectionClosedError | undefined;

  constructor(io: { stdin: Writable; stdout: Readable }) {
    this.stdin = io.stdin;
    this.stdout = io.stdout;
    this.reader = createInterface({ input: io.stdout });
    this.reader.on("line", this.handleLine);
    this.reader.on("error", this.handleError);
    this.stdin.on("error", this.handleError);
    this.stdin.on("close", this.handleClose);
    this.stdout.on("error", this.handleError);
    this.stdout.on("end", this.handleClose);
    this.stdout.on("close", this.handleClose);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch {
        // write() closes the connection and rejects every pending request.
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: JsonRpcId, result?: unknown, error?: { code: number; message: string }): void {
    if (error) {
      this.write({ jsonrpc: "2.0", id, error });
      return;
    }
    this.write({ jsonrpc: "2.0", id, result });
  }

  onNotification(handler: (method: string, params: unknown, id?: JsonRpcId) => void): () => void {
    this.notes.on("n", handler);
    return () => this.notes.off("n", handler);
  }

  onClose(handler: (error: JsonRpcConnectionClosedError) => void): () => void {
    if (this.closedError) {
      handler(this.closedError);
      return () => {};
    }
    this.lifecycle.on("close", handler);
    return () => this.lifecycle.off("close", handler);
  }

  close(): void {
    this.closeWithError();
  }

  private readonly handleLine = (line: string): void => {
    this.onLine(line);
  };

  private readonly handleError = (error: Error): void => {
    this.closeWithError(error);
  };

  private readonly handleClose = (): void => {
    this.closeWithError();
  };

  private readonly terminalErrorSink = (): void => {};

  private write(message: Record<string, unknown>): void {
    if (this.closedError) throw this.closedError;
    try {
      this.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.closeWithError(error);
      });
    } catch (error) {
      this.closeWithError(error);
      throw this.closedError;
    }
  }

  private closeWithError(cause?: unknown): void {
    if (this.closedError) return;
    const error = new JsonRpcConnectionClosedError(cause);
    this.closedError = error;
    this.reader.off("line", this.handleLine);
    this.reader.off("error", this.handleError);
    this.reader.on("error", this.terminalErrorSink);
    this.reader.close();
    queueMicrotask(() => this.reader.off("error", this.terminalErrorSink));
    this.stdin.off("error", this.handleError);
    this.stdin.off("close", this.handleClose);
    this.stdout.off("error", this.handleError);
    this.stdout.off("end", this.handleClose);
    this.stdout.off("close", this.handleClose);
    this.quiesce(this.stdin);
    this.quiesce(this.stdout);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.notes.removeAllListeners();
    this.lifecycle.emit("close", error);
    this.lifecycle.removeAllListeners();
  }

  private quiesce(stream: Readable | Writable): void {
    if (stream.closed) return;
    const cleanup = () => {
      stream.off("error", this.terminalErrorSink);
      stream.off("close", cleanup);
    };
    stream.on("error", this.terminalErrorSink);
    stream.once("close", cleanup);
    stream.destroy();
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof msg.method === "string") {
      this.notes.emit("n", msg.method, msg.params, isJsonRpcId(msg.id) ? msg.id : undefined);
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error && typeof msg.error === "object") {
        const err = msg.error as { message?: string };
        pending.reject(new Error(err.message ?? "ACP error"));
      } else {
        pending.resolve(msg.result);
      }
    }
  }
}
