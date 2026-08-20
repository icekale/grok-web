import { createHash, timingSafeEqual } from "node:crypto";
import {
  envPasswordEnabled,
  hasStoredPasswordHash,
  isStoredPasswordVerificationCached,
  verifyStoredPassword,
} from "./remote-access-config.ts";
export const GROK_WEB_AUTH_USERNAME = "grok";

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(hashSecret(actual), hashSecret(expected));
}

export function isWebPasswordEnabled(
  password: string | undefined = process.env.GROK_WEB_PASSWORD,
): boolean {
  if (envPasswordEnabled(password)) return true;
  return password === undefined && hasStoredPasswordHash();
}

function parseBasicAuthorization(
  authorization: string | null,
): { username: string; password: string } | undefined {
  if (!authorization) return undefined;

  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return undefined;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return undefined;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return undefined;
  }

  const separator = credentials.indexOf(":");
  if (separator === -1) return undefined;
  return {
    username: credentials.slice(0, separator),
    password: credentials.slice(separator + 1),
  };
}

export function isBasicAuthorizationCached(
  authorization: string | null,
  password = process.env.GROK_WEB_PASSWORD,
): boolean {
  if (password !== undefined) return false;
  const credentials = parseBasicAuthorization(authorization);
  return Boolean(
    credentials
    && secretsEqual(credentials.username, GROK_WEB_AUTH_USERNAME)
    && isStoredPasswordVerificationCached(credentials.password),
  );
}

export async function isValidBasicAuthorization(
  authorization: string | null,
  password = process.env.GROK_WEB_PASSWORD,
): Promise<boolean> {
  const credentials = parseBasicAuthorization(authorization);
  if (!credentials) return false;
  const usernameMatches = secretsEqual(credentials.username, GROK_WEB_AUTH_USERNAME);

  if (envPasswordEnabled(password)) {
    return usernameMatches && secretsEqual(credentials.password, password);
  }
  if (password !== undefined) return false;
  const passwordMatches = await verifyStoredPassword(credentials.password);
  return usernameMatches && passwordMatches;
}
