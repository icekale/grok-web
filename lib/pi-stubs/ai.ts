export type Api = any;
export type Model<T = Api> = {
  id: string;
  provider: string;
} & Record<string, any> & { readonly __api?: T };
export type AuthEvent = any;
export type AuthPrompt = any;
export type Credential = any;

export function getSupportedThinkingLevels(): string[] {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
}

export function createAssistantMessageEventStream(..._args: unknown[]): never {
  throw new Error("not implemented in foundation");
}
