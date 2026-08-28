const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function assertBindAllowed(hostname: string, password: string | boolean | undefined): void {
  if (isLoopbackHost(hostname)) return;
  if (password === true) return;
  if (typeof password === "string" && password.length >= 12 && password.length <= 256) return;
  throw new Error(
    `grok-web refuses to listen on ${hostname} without authentication. Set GROK_WEB_PASSWORD or bind 127.0.0.1.`,
  );
}
