import { createFileRoute } from "@tanstack/react-router";
import { getAppUpdate } from "@/lib/app-update";

export const Route = createFileRoute("/api/app-update")({
  server: {
    handlers: {
      GET: () => getAppUpdate(),
    },
  },
});
