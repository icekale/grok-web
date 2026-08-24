export function pwaServiceWorkerAction(nodeEnv: string): "register" | "unregister" {
  return nodeEnv === "production" ? "register" : "unregister";
}

export function leftoverForeignCacheNames(keys: string[]): string[] {
  return keys.filter((key) => key.startsWith("pi-web-"));
}

export function isCurrentGrokServiceWorker(
  scriptURL: string,
  expectedOrigin: string,
  expectedPath = "/sw.js",
): boolean {
  try {
    const url = new URL(scriptURL);
    return url.origin === expectedOrigin && url.pathname === expectedPath;
  } catch {
    return false;
  }
}
