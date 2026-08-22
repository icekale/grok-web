import { assertBindAllowed } from "./bind-guard.ts";

type BindEnv = Pick<NodeJS.ProcessEnv, "NITRO_HOST" | "HOST" | "GROK_WEB_HOSTNAME">;

export function assertServerBindAllowed(
  env: BindEnv = process.env,
  passwordEnabled: string | boolean | undefined = undefined,
): void {
  const host = env.NITRO_HOST || env.GROK_WEB_HOSTNAME || env.HOST || "127.0.0.1";
  assertBindAllowed(host, passwordEnabled);
}
