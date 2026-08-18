import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

export class JsonRpcConn {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly notes = new EventEmitter();

  constructor(io: { stdin: Writable; stdout: Readable }) {
    createInterface({ input: io.stdout }).on("line", (line) => this.onLine(line));
    this.stdin = io.stdin;
  }

  private readonly stdin: Writable;

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  respond(id: number, result?: unknown, error?: { code: number; message: string }): void {
    if (error) {
      this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error }) + "\n");
      return;
    }
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  onNotification(handler: (method: string, params: unknown, id?: number) => void): () => void {
    this.notes.on("n", handler);
    return () => this.notes.off("n", handler);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (typeof msg.method === "string") {
      this.notes.emit("n", msg.method, msg.params, typeof msg.id === "number" ? msg.id : undefined);
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
