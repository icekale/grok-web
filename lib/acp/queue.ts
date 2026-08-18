export type QueueKind = "steering" | "followUp";
export type QueueSnapshot = { steering: string[]; followUp: string[] };

export class SessionQueue {
  private steering: string[] = [];
  private followUp: string[] = [];

  snapshot(): QueueSnapshot {
    return { steering: [...this.steering], followUp: [...this.followUp] };
  }

  enqueue(kind: QueueKind, text: string): QueueSnapshot {
    this.list(kind).push(text);
    return this.snapshot();
  }

  remove(kind: QueueKind, text: string): QueueSnapshot {
    this.take(kind, text);
    return this.snapshot();
  }

  edit(kind: QueueKind, text: string, replacement: string): QueueSnapshot {
    const next = replacement.trim();
    if (!next) throw new Error("Replacement text cannot be empty");
    const list = this.list(kind);
    const index = list.indexOf(text);
    if (index !== -1) list[index] = next;
    return this.snapshot();
  }

  take(kind: QueueKind, text: string): string | undefined {
    const list = this.list(kind);
    const index = list.indexOf(text);
    if (index === -1) return undefined;
    return list.splice(index, 1)[0];
  }

  takeNext(kind: QueueKind): string | undefined {
    return this.list(kind).shift();
  }

  clear(): QueueSnapshot {
    const prev = this.snapshot();
    this.steering = [];
    this.followUp = [];
    return prev;
  }

  private list(kind: QueueKind): string[] {
    return kind === "steering" ? this.steering : this.followUp;
  }
}
