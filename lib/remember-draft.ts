let queued = "";

export function queueRememberNote(text: string): void {
  queued = text.trim();
}

export function takeQueuedRememberNote(): string {
  const text = queued;
  queued = "";
  return text;
}
