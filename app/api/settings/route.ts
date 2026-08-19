import { getGrokSettings, putGrokSettings } from "@/lib/grok-settings/http.ts";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return getGrokSettings();
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return Response.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return putGrokSettings(req);
}
