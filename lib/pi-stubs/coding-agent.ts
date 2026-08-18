import { grokHome } from "../grok-home.ts";
import { notImplemented } from "./not-implemented.ts";

export type AgentSession = any;
export type AgentSessionEvent = any;
export type BashOperations = any;
export type BeforeAgentStartEvent = any;
export type BeforeAgentStartEventResult = any;
export type ExtensionCommandContext = any;
export type InlineExtension = any;
export type JsonAgentSessionEvent = any;
export type LoadExtensionsResult = any;
export type PackageSource = any;
export type ResourceDiagnostic = any;
export type ResourceLoadResult = any;
export type ResourceLoader = any;
export type ResolvedPaths = any;
export type ResolvedResource = any;
export type ScopedModel = any;
export type SessionEntry = any;
export type SessionInfo = any;
export type Skill = any;
export type SlashCommandInfo = any;
export class Theme {
  constructor(..._args: any[]) {}
}

export const SessionManager: any = {
  listAll: async () => [],
  open: notImplemented,
  create: notImplemented,
};

export const SettingsManager: any = {
  create: notImplemented,
};

export const ModelRuntime: any = {
  create: notImplemented,
};

export const ProjectTrustStore: any = class ProjectTrustStore {
  constructor(..._args: any[]) {}
  set(..._args: any[]) {
    return this;
  }
  get(..._args: any[]) {
    return undefined;
  }
};

export const DefaultResourceLoader: any = class DefaultResourceLoader {
  constructor(..._args: any[]) {}
  async reload(..._args: any[]) {
    return this;
  }
  getSkills() {
    return { skills: [], diagnostics: [] };
  }
};

export const DefaultPackageManager: any = class DefaultPackageManager {
  constructor(..._args: any[]) {}
};

export function getAgentDir(): string {
  return grokHome();
}

export function getPackageDir(): string {
  throw new Error("not implemented in foundation");
}

export function parseFrontmatter(_source: string): { attributes: Record<string, unknown>; body: string } {
  throw new Error("not implemented in foundation");
}

export function buildContextEntries(..._args: unknown[]): unknown[] {
  return [];
}

export function buildSessionContext(..._args: unknown[]): { thinkingLevel: string; model: null } {
  return { thinkingLevel: "off", model: null };
}

export function resolveModelScopeWithDiagnostics(..._args: unknown[]): {
  models: unknown[];
  scopedModels: unknown[];
  thinkingLevelPins: Record<string, string>;
  warnings: string[];
} {
  return { models: [], scopedModels: [], thinkingLevelPins: {}, warnings: [] };
}

export function createBashToolDefinition(..._args: unknown[]): unknown {
  throw new Error("not implemented in foundation");
}

export function createLocalBashOperations(..._args: unknown[]): unknown {
  throw new Error("not implemented in foundation");
}

export function hasTrustRequiringProjectResources(..._args: unknown[]): boolean {
  return false;
}

export function createAgentSessionFromServices(..._args: unknown[]): never {
  throw new Error("not implemented in foundation");
}

export function createAgentSessionServices(..._args: unknown[]): never {
  throw new Error("not implemented in foundation");
}

export function initTheme(..._args: unknown[]): unknown {
  throw new Error("not implemented in foundation");
}

export function convertToLlm(..._args: unknown[]): unknown {
  throw new Error("not implemented in foundation");
}

export type ModelRuntime = any;
export type SessionManager = any;
export type SettingsManager = any;
export type ProjectTrustStore = any;
export type DefaultResourceLoader = any;
export type DefaultPackageManager = any;
