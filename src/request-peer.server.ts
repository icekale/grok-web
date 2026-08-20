import { getRequestIP } from "@tanstack/react-start/server";
import { getRequestSecurityRejection } from "@/lib/request-security";

export function requestPeerAddress(): string | undefined {
  try {
    return getRequestIP({ xForwardedFor: false });
  } catch {
    return undefined;
  }
}

export async function runRequestSecurityMiddleware<T>(
  request: Request,
  peerAddress: string | undefined,
  next: () => T | Promise<T>,
): Promise<Response | Awaited<T>> {
  const rejection = await getRequestSecurityRejection(request, peerAddress);
  return rejection ?? await next();
}

export function runRequestSecurityFromContext<T>(
  request: Request,
  next: () => T | Promise<T>,
): Promise<Response | Awaited<T>> {
  return runRequestSecurityMiddleware(request, requestPeerAddress(), next);
}
