import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import type { ProjectTrustStatus } from "./api-types";

interface ProjectTrustFile {
  version: 1;
  trustedProjects: string[];
}

function canonicalProjectPath(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

function directoryHasEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function settingsHaveExtensions(cwd: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")) as {
      extensions?: unknown;
    };
    return Array.isArray(parsed?.extensions) && parsed.extensions.length > 0;
  } catch {
    return false;
  }
}

function hasTrustRequiringProjectResources(cwd: string): boolean {
  return directoryHasEntries(join(cwd, ".agents", "skills"))
    || directoryHasEntries(join(cwd, ".pi", "extensions"))
    || settingsHaveExtensions(cwd);
}

function trustStorePath(agentDir: string): string {
  return join(agentDir, "grok-web", "project-trust.json");
}

function lockTrustStore(path: string): () => void {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return lockfile.lockSync(path, { realpath: false, stale: 30_000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 19) throw error;
      Atomics.wait(waitBuffer, 0, 0, Math.min(5 * (2 ** attempt), 50));
    }
  }
}

function readTrustStore(agentDir: string): {
  trustedProjects: Set<string>;
  error?: string;
} {
  const path = trustStorePath(agentDir);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { trustedProjects: new Set() };
    }
    return {
      trustedProjects: new Set(),
      error: `Unable to read project trust store ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  try {
    const parsed = JSON.parse(source) as Partial<ProjectTrustFile>;
    if (
      parsed.version !== 1
      || !Array.isArray(parsed.trustedProjects)
      || parsed.trustedProjects.some((project) => typeof project !== "string")
    ) {
      throw new Error("invalid project trust store format");
    }
    return { trustedProjects: new Set(parsed.trustedProjects) };
  } catch (error) {
    return {
      trustedProjects: new Set(),
      error: `Unable to parse project trust store ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  const projectPath = cwd ? canonicalProjectPath(cwd) : "";
  const requiresTrust = Boolean(projectPath) && hasTrustRequiringProjectResources(projectPath);
  if (!requiresTrust) return { requiresTrust: false, trusted: true };

  const store = readTrustStore(agentDir);
  return {
    requiresTrust: true,
    trusted: !store.error && store.trustedProjects.has(projectPath),
    ...(store.error ? { error: store.error } : {}),
  };
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const projectPath = canonicalProjectPath(cwd);
  if (!hasTrustRequiringProjectResources(projectPath)) {
    return { requiresTrust: false, trusted: true };
  }

  const path = trustStorePath(agentDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = lockTrustStore(path);
  try {
    const store = readTrustStore(agentDir);
    if (store.error) throw new Error(store.error);
    store.trustedProjects.add(projectPath);
    writePrivateFileAtomicSync(path, `${JSON.stringify({
      version: 1,
      trustedProjects: [...store.trustedProjects].sort(),
    } satisfies ProjectTrustFile, null, 2)}\n`);
    return { requiresTrust: true, trusted: true };
  } finally {
    release();
  }
}

/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the project-trust store.
 *
 * Pi Web *executes* project extensions when it builds session services: their
 * factory runs on import and their `session_start` handlers run on startup.
 * Without a trust gate, merely opening an untrusted repository in Pi Web runs
 * repository-controlled code locally (issue #236). The SDK's resource loader
 * only imports project extensions once `resolveProjectTrust` resolves true, so
 * denying trust keeps them dormant.
 *
 * Projects with gated resources default to untrusted until Pi Web records a
 * trust decision. The resolver always re-scans so resources added after
 * session setup cannot bypass the trust boundary.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } {
  return {
    resolveProjectTrust: async () => {
      const status = getProjectTrustStatus(cwd, agentDir);
      return !status.requiresTrust || status.trusted;
    },
  };
}
