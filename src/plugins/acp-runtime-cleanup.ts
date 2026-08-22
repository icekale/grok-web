import { definePlugin } from "nitro";
import { disposeAgentRuntime } from "@/lib/acp/runtime";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("close", disposeAgentRuntime);
});
