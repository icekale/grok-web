import { hasGrokApiKey, readGrokAuth } from "@/lib/grok-settings/home-config.ts";

export async function GET() {
  return Response.json({
    providers: [{
      id: "xai.api_key",
      displayName: "xAI API Key",
      configured: hasGrokApiKey() || readGrokAuth().loggedIn,
      modelCount: 0,
      supportsOAuth: true,
    }],
  });
}
