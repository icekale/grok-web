/**
 * Allowed HTTP methods per TanStack server-route adapter.
 *
 * TanStack Start renders the page shell when a request matches a server route
 * whose handlers do not include the request method (Next.js returned 405).
 * This table restores the legacy 405 contract. It must stay in sync with
 * `lib/tanstack-route-inventory.test.mjs` (locked by test).
 *
 * Patterns use TanStack file-route syntax: `$name` matches one segment,
 * `$` matches the remaining segments (splat).
 */
export const API_ROUTE_METHODS: Record<string, readonly string[]> = {
  "/api/agent/$id/events": ["GET"],
  "/api/agent/$id/subagents": ["GET", "POST"],
  "/api/agent/$id": ["GET", "POST"],
  "/api/agent/new": ["POST"],
  "/api/agent/running/events": ["GET"],
  "/api/agent/running": ["GET"],
  "/api/app-update": ["GET"],
  "/api/auth/all-providers": ["GET"],
  "/api/auth/api-key/$provider": ["DELETE", "GET", "POST"],
  "/api/auth/login/$provider": ["GET", "POST"],
  "/api/auth/logout/$provider": ["POST"],
  "/api/auth/providers": ["GET"],
  "/api/cwd/browse": ["GET", "POST"],
  "/api/cwd/validate": ["POST"],
  "/api/file-index": ["GET"],
  "/api/files/$": ["GET", "POST"],
  "/api/git/commit": ["POST"],
  "/api/git/diff": ["GET"],
  "/api/git/discard": ["POST"],
  "/api/git/stage": ["POST"],
  "/api/git/status": ["GET"],
  "/api/meta": ["GET", "POST"],
  "/api/models-config/catalog": ["GET"],
  "/api/models-config/discover": ["POST"],
  "/api/models-config": ["GET", "PUT"],
  "/api/models-config/test": ["POST"],
  "/api/models": ["GET"],
  "/api/mcp": ["GET", "POST"],
  "/api/plugins": ["GET", "POST"],
  "/api/hooks": ["GET", "POST"],
  "/api/project-trust": ["GET", "POST"],
  "/api/projects": ["GET", "PATCH", "PUT"],
  "/api/remote-access": ["GET", "PUT"],
  "/api/runtime-profile": ["GET", "PUT"],
  "/api/settings": ["GET", "PUT"],
  "/api/sessions/$id/auto-name": ["POST"],
  "/api/sessions/$id/context": ["GET"],
  "/api/sessions/$id/entries/$entryId/thinking": ["GET"],
  "/api/sessions/$id/entries/$entryId/tool-result": ["GET"],
  "/api/sessions/$id/export": ["GET"],
  "/api/sessions/$id/restore-code": ["POST"],
  "/api/sessions/$id": ["DELETE", "GET", "PATCH"],
  "/api/sessions/$id/state": ["GET"],
  "/api/sessions": ["GET"],
  "/api/skills/check": ["POST"],
  "/api/skills/install": ["POST"],
  "/api/skills": ["GET", "PATCH"],
  "/api/skills/search": ["POST"],
  "/api/skills/update": ["POST"],
  "/api/ui-locale": ["GET", "PUT"],
  "/api/vision-toolkit": ["GET", "PUT"],
  "/api/vision-toolkit/health": ["POST"],
  "/api/vision-toolkit/reveal": ["POST"],
  "/api/worktrees": ["DELETE", "GET", "POST"],
};

/** Match a request pathname against a TanStack-style route pattern. */
export function matchApiRoutePattern(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];
    if (segment === "$") return index < pathSegments.length || pathname.endsWith("/");
    if (index >= pathSegments.length) return false;
    if (segment.startsWith("$")) continue;
    if (segment !== pathSegments[index]) return false;
  }
  return patternSegments.length === pathSegments.length;
}

export function apiRouteSpecificity(pattern: string): number {
  let score = 0;
  for (const segment of pattern.split("/").filter(Boolean)) {
    if (segment === "$") score += 1;
    else if (segment.startsWith("$")) score += 10;
    else score += 100;
  }
  return score * 1000 + pattern.length;
}

export function findApiRoute(pathname: string): [string, readonly string[]] | undefined {
  let best: [string, readonly string[], number] | undefined;
  for (const [pattern, methods] of Object.entries(API_ROUTE_METHODS)) {
    if (!matchApiRoutePattern(pattern, pathname)) continue;
    const score = apiRouteSpecificity(pattern);
    if (!best || score > best[2]) best = [pattern, methods, score];
  }
  return best ? [best[0], best[1]] : undefined;
}

/** 405 rejection for /api/* requests whose method is not allowed by the adapter. */
export function getApiMethodRejection(request: Request): Response | undefined {
  const pathname = new URL(request.url).pathname;
  const match = findApiRoute(pathname);
  if (!match) return undefined;
  const [, methods] = match;
  if (methods.includes(request.method)) return undefined;
  return new Response(null, {
    status: 405,
    headers: { Allow: [...methods].join(", ") },
  });
}
