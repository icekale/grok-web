import { createFileRoute } from "@tanstack/react-router";
import {
  GET as getSkills,
  PATCH as patchSkills,
} from "@/lib/skills-http";

export const Route = createFileRoute("/api/skills")({
  server: {
    handlers: {
      GET: ({ request }) => getSkills(request),
      PATCH: ({ request }) => patchSkills(request),
    },
  },
});
