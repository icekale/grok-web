import { createFileRoute } from "@tanstack/react-router";
import {
  GET as getProjects,
  PATCH as patchProjects,
  PUT as putProjects,
} from "@/lib/projects-http";

export const Route = createFileRoute("/api/projects")({
  server: {
    handlers: {
      GET: () => getProjects(),
      PATCH: ({ request }) => patchProjects(request),
      PUT: ({ request }) => putProjects(request),
    },
  },
});
