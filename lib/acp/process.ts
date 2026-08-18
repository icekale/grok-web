import { existsSync } from "node:fs";
import { join } from "node:path";
import { grokHome } from "../grok-home.ts";

export function resolveGrokBin(): string {
  const override = process.env.GROK_BIN?.trim();
  if (override && existsSync(override)) return override;
  const fallback = join(grokHome(), "bin", "grok");
  if (existsSync(fallback)) return fallback;
  throw new Error("grok-missing: install grok or set GROK_BIN");
}

export function grokAgentArgs(): string[] {
  return ["agent", "stdio"];
}
