import { createFileRoute } from "@tanstack/react-router";
import {
  GET as getModelsConfig,
  PUT as putModelsConfig,
} from "@/lib/models-config-http";

export const Route = createFileRoute("/api/models-config")({
  server: {
    handlers: {
      GET: () => getModelsConfig(),
      PUT: ({ request }) => putModelsConfig(request),
    },
  },
});
