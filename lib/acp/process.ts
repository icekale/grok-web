import { existsSync } from "node:fs";
import { join } from "node:path";
import { grokHome } from "../grok-home.ts";

export function formatGrokMissingError(): string {
  return "grok-missing: install grok (curl -fsSL https://x.ai/cli/install.sh | bash) or set GROK_BIN";
}

export function resolveGrokBin(): string {
  const override = process.env.GROK_BIN?.trim();
  if (override && existsSync(override)) return override;
  const fallback = join(grokHome(), "bin", "grok");
  if (existsSync(fallback)) return fallback;
  throw new Error(formatGrokMissingError());
}

export function grokAgentArgs(): string[] {
  return ["agent", "stdio"];
}
