import { createFileRoute } from "@tanstack/react-router";
import {
  GET as getBrowse,
  POST as postBrowse,
} from "@/lib/cwd-browse-http";

export const Route = createFileRoute("/api/cwd/browse")({
  server: {
    handlers: {
      GET: ({ request }) => getBrowse(request),
      POST: ({ request }) => postBrowse(request),
    },
  },
});
