import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";

export interface DiscoveredModel {
  id: string;
  name?: string;
}

// Source: IANA IPv4 Special-Purpose Address Space, last updated 2025-10-09
// (retrieved 2026-08-20). Keep CIDRs explicit so registry additions are reviewable.
const SPECIAL_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  // Multicast is non-global but not a special-purpose registry row.
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const SPECIAL_IPV4 = new BlockList();
for (const [network, prefix] of SPECIAL_IPV4_CIDRS) {
  SPECIAL_IPV4.addSubnet(network, prefix, "ipv4");
}

// Source: IANA IPv6 Special-Purpose Address Space, last updated 2025-10-09
// (retrieved 2026-08-20). Keep CIDRs explicit so registry additions are reviewable.
const SPECIAL_IPV6_CIDRS = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  // Deprecated site-local and multicast are non-global but not registry rows.
  ["fec0::", 10],
  ["ff00::", 8],
] as const;

const SPECIAL_IPV6 = new BlockList();
for (const [network, prefix] of SPECIAL_IPV6_CIDRS) {
  SPECIAL_IPV6.addSubnet(network, prefix, "ipv6");
}

function isPrivateIpv4(address: string): boolean {
  return isIP(address) !== 4 || SPECIAL_IPV4.check(address, "ipv4");
}

function isPrivateIpv6(address: string): boolean {
  return SPECIAL_IPV6.check(address, "ipv6");
}

function normalizeDiscoveryHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

function mappedIpv4(hostname: string): string | undefined {
  const normalized = normalizeDiscoveryHostname(hostname);
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (dotted && isIP(dotted) === 4) return dotted;
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!hexadecimal) return undefined;
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeDiscoveryHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const mapped = mappedIpv4(normalized);
  if (mapped) return isLoopbackHostname(mapped);
  const ipKind = isIP(normalized);
  if (ipKind === 4) return normalized.split(".").map(Number)[0] === 127;
  if (ipKind === 6) return normalized === "::1";
  return false;
}

function isLanIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isLanHostname(hostname: string): boolean {
  const normalized = normalizeDiscoveryHostname(hostname);
  const mapped = mappedIpv4(normalized);
  if (mapped) return isLanIpv4(mapped);
  const ipKind = isIP(normalized);
  if (ipKind === 4) return isLanIpv4(normalized);
  if (ipKind === 6) {
    const lower = normalized.toLowerCase();
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  }
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = normalizeDiscoveryHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "" || normalized.includes("%")) return true;
  const ipKind = isIP(normalized);
  if (ipKind === 4) return isPrivateIpv4(normalized);
  if (ipKind === 6) return isPrivateIpv6(normalized);
  return false; // Public DNS names are resolved and pinned by safeDiscoveryFetch.
}

export interface DiscoveryTargetAuth {
  apiKey?: string;
  headers?: Record<string, string | null | undefined>;
}

export interface DiscoveryLookupAddress {
  address: string;
  family: 4 | 6;
}

export type DiscoveryLookup = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly DiscoveryLookupAddress[]>;
type DiscoveryFetchInit = RequestInit & { dispatcher?: Dispatcher };
type DiscoveryFetch = (input: string | URL, init?: DiscoveryFetchInit) => Promise<Response>;
type PinnedLookup = (
  hostname: string,
  options: number | { all?: boolean; family?: number },
  callback: (...args: unknown[]) => void,
) => void;

export interface SafeDiscoveryFetchOptions {
  fetchImpl?: DiscoveryFetch;
  lookup?: DiscoveryLookup;
  createDispatcher?: (lookup: PinnedLookup) => Dispatcher;
}

const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_HEADERS = new Set(["accept", "content-type", "user-agent"]);
const REQUEST_BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type", "content-length"];

/**
 * Guards discovery/test fetches against SSRF. Scheme is restricted to http(s).
 * Link-local and special-use destinations (cloud metadata, unspecified,
 * multicast) are never allowed. Loopback and RFC1918/ULA LAN addresses stay
 * allowed so local and LAN OpenAI-compatible proxies work.
 */
export function assertSafeDiscoveryTarget(target: URL, _auth: DiscoveryTargetAuth = {}): void {
  void _auth;
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (
    isPrivateHostname(target.hostname)
    && !isLoopbackHostname(target.hostname)
    && !isLanHostname(target.hostname)
  ) {
    throw new Error("Base URL must not target a link-local or special-use address");
  }
}

function assertSafeResolvedAddress(address: string): void {
  const family = isIP(address);
  const allowed = family === 4
    ? isLoopbackHostname(address) || isLanIpv4(address)
    : family === 6 && (isLoopbackHostname(address) || isLanHostname(address));
  const special = family === 4 ? isPrivateIpv4(address) : family === 6 && isPrivateIpv6(address);
  if (!family || (special && !allowed)) {
    throw new Error(`Base URL resolved to a link-local or special-use address: ${address}`);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function resolveSafeAddresses(
  target: URL,
  lookup: DiscoveryLookup,
  signal: AbortSignal | null | undefined,
): Promise<DiscoveryLookupAddress[]> {
  const hostname = normalizeDiscoveryHostname(target.hostname);
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : [...await abortable(Promise.resolve(lookup(hostname, signal ?? undefined)), signal)];
  if (addresses.length === 0) throw new Error(`Base URL hostname did not resolve: ${hostname}`);
  for (const result of addresses) {
    if (isIP(result.address) !== result.family) {
      throw new Error(`Base URL hostname returned an invalid address: ${result.address}`);
    }
    assertSafeResolvedAddress(result.address);
  }
  return addresses;
}

function pinnedLookup(addresses: readonly DiscoveryLookupAddress[]): PinnedLookup {
  return (_hostname, options, callback) => {
    const family = typeof options === "number" ? options : options.family;
    const selected = family === 4 || family === 6
      ? addresses.filter((address) => address.family === family)
      : addresses;
    if (selected.length === 0) {
      const error = Object.assign(new Error("No validated address for requested family"), { code: "ENOTFOUND" });
      callback(error);
    } else if (typeof options !== "number" && options.all) {
      callback(null, selected);
    } else {
      callback(null, selected[0].address, selected[0].family);
    }
  };
}

function redirectedHeaders(headers: Headers, crossOrigin: boolean): Headers {
  if (!crossOrigin) return headers;
  const safe = new Headers();
  for (const [name, value] of headers) {
    if (CROSS_ORIGIN_HEADERS.has(name.toLowerCase())) safe.set(name, value);
  }
  return safe;
}

function redirectRequestInit(init: DiscoveryFetchInit, status: number, crossOrigin: boolean): DiscoveryFetchInit {
  const next = { ...init, headers: redirectedHeaders(new Headers(init.headers), crossOrigin) };
  const method = (next.method ?? "GET").toUpperCase();
  if (
    (status === 303 && method !== "GET" && method !== "HEAD")
    || ((status === 301 || status === 302) && method === "POST")
  ) {
    next.method = "GET";
    delete next.body;
    const headers = new Headers(next.headers);
    for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
    next.headers = headers;
  }
  return next;
}

async function bufferedResponse(response: Response, dispatcher: Dispatcher): Promise<Response> {
  try {
    const body = response.body ? await response.arrayBuffer() : null;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await dispatcher.close();
  }
}

export async function safeDiscoveryFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeDiscoveryFetchOptions = {},
): Promise<Response> {
  const lookup = options.lookup ?? (async (hostname) => {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses as DiscoveryLookupAddress[];
  });
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as DiscoveryFetch);
  const createDispatcher = options.createDispatcher
    ?? ((safeLookup: PinnedLookup) => new Agent({ connect: { lookup: safeLookup as never } }));
  let target = new URL(input);
  let requestInit: DiscoveryFetchInit = { ...init, headers: new Headers(init.headers), redirect: "manual" };

  for (let redirects = 0; ; redirects += 1) {
    requestInit.signal?.throwIfAborted();
    assertSafeDiscoveryTarget(target);
    const addresses = await resolveSafeAddresses(target, lookup, requestInit.signal);
    const dispatcher = createDispatcher(pinnedLookup(addresses));
    let response: Response;
    try {
      response = await fetchImpl(target, { ...requestInit, dispatcher, redirect: "manual" });
    } catch (error) {
      await dispatcher.close();
      throw error;
    }

    if (!REDIRECT_STATUSES.has(response.status)) return bufferedResponse(response, dispatcher);
    try {
      await response.body?.cancel();
    } finally {
      await dispatcher.close();
    }
    if (redirects >= DEFAULT_MAX_REDIRECTS) {
      throw new Error(`Upstream redirect limit exceeded (${DEFAULT_MAX_REDIRECTS})`);
    }
    const location = response.headers.get("location");
    if (!location) throw new Error(`Upstream redirect response ${response.status} did not include Location`);
    const nextTarget = new URL(location, target);
    requestInit = redirectRequestInit(requestInit, response.status, nextTarget.origin !== target.origin);
    target = nextTarget;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const OPENAI_STYLE_APIS = new Set(["openai-completions", "openai-responses", "openai-codex-responses"]);

/**
 * OpenAI-compatible relays serve `/v1/chat/completions` and `/v1/responses`;
 * a host-only baseUrl omitting `/v1` hits the bare path, which some relays
 * (e.g. codex2api.com) WAF-block for the SDK's `OpenAI/*` User-Agent while
 * still answering a plain `/models` discovery — so discovery succeeds and the
 * saved config then fails. Normalize a host-only baseUrl to include `/v1` for
 * OpenAI-style APIs so discovery and completions use the same path.
 */
export function normalizeProviderBaseUrl(baseUrl: unknown, api: unknown): string {
  if (typeof baseUrl !== "string") return "";
  const trimmed = baseUrl.trim();
  if (!trimmed || typeof api !== "string" || !OPENAI_STYLE_APIS.has(api)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") url.pathname = "/v1";
  return url.toString();
}

function modelFromValue(value: unknown): DiscoveredModel | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!isRecord(value)) return null;

  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name);
  if (!rawId) return null;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return null;
  const name = cleanString(value.display_name)
    ?? cleanString(value.displayName)
    ?? (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined);
  return name && name !== id ? { id, name } : { id };
}

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "models", "results", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) return Object.values(candidate);
  }
  return [];
}

export function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

export function buildModelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(normalizeProviderBaseUrl(baseUrl, api));
  const trimmedPath = url.pathname.replace(/\/+$/, "");

  if (!/\/models$/i.test(trimmedPath)) {
    let path = trimmedPath;
    if (api === "anthropic-messages" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1beta";
    url.pathname = `${path}/models`.replace(/\/+/g, "/");
  }

  if (api === "anthropic-messages" && !url.searchParams.has("limit")) {
    url.searchParams.set("limit", "1000");
  }
  if (api === "google-generative-ai" && !url.searchParams.has("pageSize")) {
    url.searchParams.set("pageSize", "1000");
  }
  return url;
}
