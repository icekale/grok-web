import { homedir } from "node:os";
import { join } from "node:path";

export function grokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override || join(homedir(), ".grok");
}

export function grokSessionsDir(): string {
  return join(grokHome(), "sessions");
}

export function grokWebMetaDir(): string {
  return join(grokHome(), "grok-web");
}
