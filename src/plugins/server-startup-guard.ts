import { definePlugin } from "nitro";
import { assertServerBindAllowed } from "@/lib/server-bind";
import { isWebPasswordEnabled } from "@/lib/web-auth";

export default definePlugin(() => {
  assertServerBindAllowed(
    process.env,
    isWebPasswordEnabled(),
  );
});
