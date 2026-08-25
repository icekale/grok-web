export interface AppVersionInfo {
  appVersion: string;
  buildId: string;
}

type VersionEnv = Partial<Pick<NodeJS.ProcessEnv, "NEXT_PUBLIC_APP_VERSION" | "NEXT_PUBLIC_BUILD_ID">>;

declare const __GROK_WEB_APP_VERSION__: string | undefined;
declare const __GROK_WEB_BUILD_ID__: string | undefined;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function currentAppVersion(env: VersionEnv = process.env): AppVersionInfo {
  const appVersion = nonEmpty(env.NEXT_PUBLIC_APP_VERSION)
    ?? (typeof __GROK_WEB_APP_VERSION__ === "string" ? __GROK_WEB_APP_VERSION__ : undefined)
    ?? "0.0.0";
  return {
    appVersion,
    buildId: nonEmpty(env.NEXT_PUBLIC_BUILD_ID)
      ?? (typeof __GROK_WEB_BUILD_ID__ === "string" ? __GROK_WEB_BUILD_ID__ : undefined)
      ?? appVersion,
  };
}

export function hasNewBuild(clientBuildId: string, serverBuildId: string): boolean {
  return Boolean(clientBuildId && serverBuildId && clientBuildId !== serverBuildId);
}

export function getAppVersion(env: VersionEnv = process.env): Response {
  return Response.json(currentAppVersion(env), {
    headers: { "Cache-Control": "no-store" },
  });
}
