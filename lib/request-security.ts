import { isIP } from "node:net";
import { readRemoteAccessAllowedHosts } from "./remote-access-config.ts";
import {
  isBasicAuthorizationCached,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "./web-auth.ts";

/** A peer receives 401 for five failures, then 429 until this window expires. */
export const AUTH_FAILURE_LIMIT = 5;
export const AUTH_FAILURE_TTL_MS = 60_000;
export const AUTH_FAILURE_MAX_PEERS = 1_024;
export const AUTH_UNKNOWN_MAX_IN_FLIGHT = 4;

type AuthReservation =
  | { allowed: false; retryAfter: number }
  | { allowed: true; complete(success: boolean): void };

export type FailedAuthRateLimiter = {
  readonly size: number;
  reserve(peerAddress?: string | null, options?: { expensive?: boolean }): AuthReservation;
  clearFailures(peerAddress?: string | null): void;
};

function canonicalPeerAddress(peerAddress?: string | null): string | undefined {
  const raw = peerAddress?.trim();
  if (!raw) return undefined;
  const unbracketed = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const address = unbracketed.split("%", 1)[0] ?? "";
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;

  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function createFailedAuthRateLimiter(options: {
  now?: () => number;
  threshold?: number;
  ttlMs?: number;
  maxPeers?: number;
  maxUnknownInFlight?: number;
} = {}): FailedAuthRateLimiter {
  const now = options.now ?? Date.now;
  const threshold = options.threshold ?? AUTH_FAILURE_LIMIT;
  const ttlMs = options.ttlMs ?? AUTH_FAILURE_TTL_MS;
  const maxPeers = options.maxPeers ?? AUTH_FAILURE_MAX_PEERS;
  const maxUnknownInFlight = options.maxUnknownInFlight ?? AUTH_UNKNOWN_MAX_IN_FLIGHT;
  const failures = new Map<string, { failures: number; pending: number; expiresAt: number }>();
  let unknownFailures = 0;
  let unknownPending = 0;
  let unknownExpiresAt = 0;
  let unknownInFlight = 0;

  function pruneExpired(timestamp: number): void {
    for (const [peer, failure] of failures) {
      if (failure.expiresAt > 0 && failure.expiresAt <= timestamp) {
        failure.failures = 0;
        failure.expiresAt = 0;
        if (failure.pending === 0) failures.delete(peer);
      }
    }
    if (unknownExpiresAt > 0 && unknownExpiresAt <= timestamp) {
      unknownFailures = 0;
      unknownExpiresAt = 0;
    }
  }

  return {
    get size() {
      return failures.size;
    },
    clearFailures(peerAddress) {
      const peer = canonicalPeerAddress(peerAddress);
      if (!peer) {
        unknownFailures = 0;
        unknownExpiresAt = 0;
        return;
      }
      const current = failures.get(peer);
      if (!current) return;
      current.failures = 0;
      current.expiresAt = 0;
      if (current.pending === 0) failures.delete(peer);
    },
    reserve(peerAddress, reservationOptions = {}) {
      const timestamp = now();
      pruneExpired(timestamp);
      const peer = canonicalPeerAddress(peerAddress);
      if (!peer) {
        if (unknownFailures + unknownPending >= threshold) {
          const retryAfter = unknownFailures >= threshold && unknownExpiresAt > timestamp
            ? Math.max(1, Math.ceil((unknownExpiresAt - timestamp) / 1_000))
            : 1;
          return { allowed: false, retryAfter };
        }
        const expensive = reservationOptions.expensive ?? true;
        if (expensive && unknownInFlight >= maxUnknownInFlight) {
          return { allowed: false, retryAfter: 1 };
        }
        unknownPending += 1;
        if (expensive) unknownInFlight += 1;
        let completed = false;
        return {
          allowed: true,
          complete(success) {
            if (completed) return;
            completed = true;
            unknownPending -= 1;
            if (expensive) unknownInFlight -= 1;
            if (success) {
              unknownFailures = 0;
              unknownExpiresAt = 0;
            } else {
              unknownFailures += 1;
              unknownExpiresAt = now() + ttlMs;
            }
          },
        };
      }

      let current = failures.get(peer);
      if (!current) {
        if (failures.size >= maxPeers) {
          return { allowed: false, retryAfter: 1 };
        }
        current = { failures: 0, pending: 0, expiresAt: 0 };
        failures.set(peer, current);
      }

      if (current.failures + current.pending >= threshold) {
        const retryAfter = current.failures >= threshold && current.expiresAt > timestamp
          ? Math.max(1, Math.ceil((current.expiresAt - timestamp) / 1_000))
          : 1;
        return { allowed: false, retryAfter };
      }

      current.pending += 1;
      let completed = false;
      return {
        allowed: true,
        complete(success) {
          if (completed) return;
          completed = true;
          current.pending -= 1;
          if (success) {
            current.failures = 0;
            current.expiresAt = 0;
          } else {
            current.failures += 1;
            current.expiresAt = now() + ttlMs;
          }
          if (current.pending === 0 && current.failures === 0) failures.delete(peer);
        },
      };
    },
  };
}

const failedAuthRateLimiter = createFailedAuthRateLimiter();

function normalizeHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function hostnameFromAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isIP(trimmed) ? normalizeHostname(trimmed) : hostnameFromAuthority(trimmed);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function configuredHostnamesFromEnvironment(): string[] {
  return [
    process.env.GROK_WEB_HOSTNAME,
    ...(process.env.GROK_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
}

function configuredHostnames(): string[] {
  return [
    ...configuredHostnamesFromEnvironment(),
    ...readRemoteAccessAllowedHosts(),
  ];
}

function requestHostname(request: Request): string | null {
  const host = request.headers.get("host");
  return host ? hostnameFromAuthority(host) : null;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "http:") return "80";
  if (url.protocol === "https:") return "443";
  return "";
}

function isUserInitiatedSessionExportNavigation(request: Request): boolean {
  if (
    request.method !== "GET"
    || request.headers.get("sec-fetch-mode") !== "navigate"
    || request.headers.get("sec-fetch-dest") !== "document"
    || request.headers.get("sec-fetch-user") !== "?1"
  ) {
    return false;
  }

  try {
    return /^\/api\/sessions\/[^/]+\/export$/.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

function isLoopbackPeer(address: string | undefined | null): boolean {
  if (!address) return false;
  const host = normalizeHostname(address.split("%", 1)[0] ?? "");
  const ip = host.startsWith("::ffff:") ? host.slice(7) : host;
  return ip === "127.0.0.1" || ip === "::1" || isLoopbackHostname(ip);
}

export function isLoopbackApiRequest(
  request: Request,
  peerAddress?: string | null,
): boolean {
  const hostname = requestHostname(request);
  if (!hostname) return false;
  const hostIsLoopback = isLoopbackHostname(hostname) || hostname === "127.0.0.1" || hostname === "::1";
  return hostIsLoopback && isLoopbackPeer(peerAddress);
}

/**
 * Only trust local names, IP literals, or the hostname explicitly selected by
 * the operator. IP literals preserve LAN access but cannot be DNS-rebound
 * because the browser keeps the literal address in the Host header.
 */
export function isApiRequestHostAllowed(
  request: Request,
  configured = configuredHostnames(),
): boolean {
  const hostname = requestHostname(request);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname) || isIP(hostname)) return true;

  return configured.some(
    (value) => normalizeConfiguredHostname(value) === hostname,
  );
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isApiRequestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const host = requestHostname(request);
  if (!host) return false;
  try {
    const originUrl = new URL(origin);
    if (
      (originUrl.protocol !== "http:" && originUrl.protocol !== "https:")
      || originUrl.username
      || originUrl.password
      || originUrl.pathname !== "/"
      || originUrl.search
      || originUrl.hash
    ) {
      return false;
    }
    const requestUrl = new URL(request.url);
    const requestOrigin = new URL(`${requestUrl.protocol}//${request.headers.get("host")}`);
    return originUrl.protocol === requestOrigin.protocol
      && normalizeHostname(originUrl.hostname) === host
      && effectivePort(originUrl) === effectivePort(requestOrigin);
  } catch {
    return false;
  }
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

export function isApiRequestAllowed(
  request: Request,
  configured = configuredHostnames(),
): boolean {
  if (!isApiRequestHostAllowed(request, configured)) return false;
  if (isUserInitiatedSessionExportNavigation(request)) return true;
  return !shouldCheckApiRequestOrigin(request) || isApiRequestOriginAllowed(request);
}

export function hasJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}

export async function getRequestSecurityRejection(
  request: Request,
  peerAddress?: string | null,
  rateLimiter: FailedAuthRateLimiter = failedAuthRateLimiter,
  verifyAuthorization: (authorization: string | null) => Promise<boolean> = isValidBasicAuthorization,
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/" && pathname !== "/api" && !pathname.startsWith("/api/")) {
    return undefined;
  }
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    return isApiRequest
      ? Response.json({ error: "Untrusted API request" }, { status: 403 })
      : new Response("Untrusted request", { status: 403 });
  }

  if (isWebPasswordEnabled() && !isLoopbackApiRequest(request, peerAddress)) {
    const authorization = request.headers.get("authorization");
    if (isBasicAuthorizationCached(authorization)) {
      rateLimiter.clearFailures(peerAddress);
      return undefined;
    }
    const reservation = rateLimiter.reserve(peerAddress, { expensive: true });
    if (!reservation.allowed) {
      return new Response("Too many authentication attempts", {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(reservation.retryAfter),
        },
      });
    }

    let valid = false;
    try {
      valid = await verifyAuthorization(authorization);
      if (valid) return undefined;
      return new Response("Authentication required", {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "WWW-Authenticate": 'Basic realm="Grok Web", charset="UTF-8"',
        },
      });
    } finally {
      reservation.complete(valid);
    }
  }

  return undefined;
}
