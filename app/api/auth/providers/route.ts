import { ModelRuntime } from "@/lib/pi-stubs/coding-agent";
import { buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { readGrokAuth } from "@/lib/grok-settings/home-config.ts";

export async function GET() {
  const grok = {
    id: "grok.com",
    name: "Grok",
    connected: readGrokAuth().loggedIn,
  };
  try {
    const modelRuntime = await ModelRuntime.create();
    const providers = buildOAuthProviderList(await collectProviderListingInputs(modelRuntime));
    return Response.json({ providers: [...providers, grok] });
  } catch {
    return Response.json({ providers: [grok] });
  }
}
