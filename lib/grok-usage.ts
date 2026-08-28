export type GrokAssistantUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export function parseGrokTurnUsage(value: unknown): GrokAssistantUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberField(value.inputTokens ?? value.input_tokens);
  const outputTokens = numberField(value.outputTokens ?? value.output_tokens) ?? 0;
  const cacheRead = numberField(
    value.cachedReadTokens ?? value.cacheReadTokens ?? value.cache_read_tokens,
  ) ?? 0;
  const cacheWrite = numberField(
    value.cacheCreationTokens ?? value.cacheWriteTokens ?? value.cache_creation_tokens,
  ) ?? 0;
  const reasoning = numberField(value.reasoningTokens ?? value.reasoning_tokens);
  if (inputTokens == null && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning == null) {
    return undefined;
  }
  const ticks = numberField(value.costUsdTicks ?? value.cost_usd_ticks);
  return {
    input: Math.max(0, (inputTokens ?? 0) - cacheRead),
    output: outputTokens,
    cacheRead,
    cacheWrite,
    ...(reasoning != null ? { reasoning } : {}),
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: ticks == null ? 0 : ticks / 1_000_000_000,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
