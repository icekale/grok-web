import { createFileRoute } from "@tanstack/react-router";
import { getAppVersion } from "@/lib/app-version";
import { postMeta } from "@/lib/session-http";

export const Route = createFileRoute("/api/meta")({
  server: {
    handlers: {
      GET: () => getAppVersion(),
      POST: ({ request }) => postMeta(request),
    },
  },
});
