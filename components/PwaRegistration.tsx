"use client";

import { useEffect } from "react";
import { isCurrentGrokServiceWorker, leftoverForeignCacheNames, pwaServiceWorkerAction } from "@/lib/pwa-registration";

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (pwaServiceWorkerAction(process.env.NODE_ENV ?? "development") === "unregister") {
      void navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) void reg.unregister();
      });
      return;
    }

    const register = () => {
      const buildId = process.env.NEXT_PUBLIC_BUILD_ID ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(buildId)}`;
      const origin = window.location.origin;

      void Promise.all([
        "caches" in window
          ? caches.keys().then((keys) => Promise.all(leftoverForeignCacheNames(keys).map((key) => caches.delete(key))))
          : Promise.resolve(),
        navigator.serviceWorker.getRegistrations().then((regs) =>
          Promise.all(
            regs.map((reg) => {
              const scriptURL = reg.active?.scriptURL ?? reg.waiting?.scriptURL ?? reg.installing?.scriptURL ?? "";
              return isCurrentGrokServiceWorker(scriptURL, origin) ? Promise.resolve(false) : reg.unregister();
            }),
          ),
        ),
      ]).then(() =>
        navigator.serviceWorker.register(scriptUrl, {
          scope: "/",
          updateViaCache: "none",
        }),
      ).catch((error: unknown) => {
        console.error("Failed to register the Grok Web service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
