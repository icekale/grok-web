import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const ACP_FS_MAX_BYTES = 8 * 1024 * 1024;

export function readAcpTextFile(
  params: unknown,
  roots: Set<string>,
  cwd?: string,
): { content: string } {
  const path = jailedPath(params, roots, cwd);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Access denied");
  if (stat.size > ACP_FS_MAX_BYTES) throw new Error("file too large");
  const text = readFileSync(path, "utf8");
  const line = optionalCount(params, "line");
  const limit = optionalCount(params, "limit");
  if (line == null && limit == null) return { content: text };
  const lines = text.split("\n");
  const start = line == null ? 0 : Math.max(line - 1, 0);
  return { content: (limit == null ? lines.slice(start) : lines.slice(start, start + limit)).join("\n") };
}

export function writeAcpTextFile(params: unknown, roots: Set<string>, cwd?: string): null {
  if (!isRecord(params) || typeof params.content !== "string") {
    throw new Error("content is required");
  }
  const path = jailedPath(params, roots, cwd, { createParents: true });
  writeFileSync(path, params.content, "utf8");
  return null;
}

function jailedPath(
  params: unknown,
  roots: Set<string>,
  cwd?: string,
  options: { createParents?: boolean } = {},
): string {
  const raw = requiredPath(params);
  const allowed = canonicalizeRoots(roots);
  if (allowed.size === 0) throw new Error("Access denied");
  if (!isAbsolute(raw) && !cwd) throw new Error("Access denied");
  const absolute = resolve(cwd ?? ".", raw);
  if (!isPathWithinRoots(absolute, allowed)) throw new Error("Access denied");

  const ancestor = existingAncestor(absolute);
  if (!isPathWithinRoots(ancestor, allowed)) throw new Error("Access denied");

  if (existsSync(absolute)) {
    const real = realpathSync(absolute);
    if (!isPathWithinRoots(real, allowed)) throw new Error("Access denied");
    return real;
  }

  if (!options.createParents) throw new Error("Access denied");
  mkdirSync(dirname(absolute), { recursive: true });
  if (!isPathWithinRoots(resolve(absolute), allowed)) throw new Error("Access denied");
  return absolute;
}

function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  const resolvedTarget = resolve(target);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, resolvedTarget);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return true;
  }
  return false;
}

function canonicalizeRoots(roots: Set<string>): Set<string> {
  const allowed = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    allowed.add(resolve(root));
    try {
      allowed.add(realpathSync(root));
    } catch {
      // Missing roots stay lexical so new session cwds can still authorize writes.
    }
  }
  return allowed;
}

function existingAncestor(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error("Access denied");
    current = parent;
  }
  return realpathSync(current);
}

function requiredPath(params: unknown): string {
  const path = isRecord(params) && typeof params.path === "string" ? params.path : "";
  if (!path) throw new Error("path is required");
  return path;
}

function optionalCount(params: unknown, key: string): number | undefined {
  if (!isRecord(params) || typeof params[key] !== "number" || !Number.isInteger(params[key]) || params[key] < 0) {
    return undefined;
  }
  return params[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
