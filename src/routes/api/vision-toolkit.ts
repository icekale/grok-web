import { createFileRoute } from "@tanstack/react-router";
import { GET as getVisionToolkit, PUT as putVisionToolkit } from "@/lib/vision-toolkit-http";

export const Route = createFileRoute("/api/vision-toolkit")({
  server: {
    handlers: {
      GET: ({ request }) => getVisionToolkit(request),
      PUT: ({ request }) => putVisionToolkit(request),
    },
  },
});
