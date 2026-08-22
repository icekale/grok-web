import "@/lib/http-dispatcher-init";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { assertServerBindAllowed } from "@/lib/server-bind";
import { isWebPasswordEnabled } from "@/lib/web-auth";

configureHttpDispatcher();
assertServerBindAllowed(
  process.env,
  process.env.GROK_WEB_PASSWORD || isWebPasswordEnabled(),
);

export default createServerEntry({
  fetch(request) {
    return handler.fetch(request);
  },
});
