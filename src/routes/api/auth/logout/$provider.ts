import { createFileRoute } from "@tanstack/react-router";
import { POST as postLogout } from "@/lib/auth-logout-http";

export const Route = createFileRoute("/api/auth/logout/$provider")({
  server: {
    handlers: {
      POST: ({ request, params }) => postLogout(request, {
        params: Promise.resolve({ provider: params.provider }),
      }),
    },
  },
});
