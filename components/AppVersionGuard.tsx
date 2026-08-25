"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { hasNewBuild, type AppVersionInfo } from "@/lib/app-version";

const UPDATE_CHECK_INTERVAL_MS = 60_000;
const CLIENT_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

function isAppVersionInfo(value: unknown): value is AppVersionInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<AppVersionInfo>;
  return typeof body.appVersion === "string" && typeof body.buildId === "string";
}

export function AppVersionGuard() {
  const { t } = useI18n();
  const [newBuildId, setNewBuildId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | null = null;

    const check = async () => {
      if (disposed || document.visibilityState !== "visible" || activeController) return;
      const controller = new AbortController();
      activeController = controller;
      try {
        const response = await fetch("/api/meta", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!isAppVersionInfo(body) || !hasNewBuild(CLIENT_BUILD_ID, body.buildId)) return;
        if (!disposed) setNewBuildId(body.buildId);
      } catch {
        // Version checks are best-effort and must not interrupt the workspace.
      } finally {
        if (activeController === controller) activeController = null;
      }
    };

    const interval = window.setInterval(() => { void check(); }, UPDATE_CHECK_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void check();

    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      activeController?.abort();
    };
  }, []);

  if (!newBuildId) return null;

  return (
    <div className="app-version-banner" role="status" aria-live="polite" data-build-id={newBuildId}>
      <span>{t("appUpdate.newVersion")}</span>
      <button type="button" onClick={() => window.location.reload()}>
        <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
        {t("appUpdate.reload")}
      </button>
    </div>
  );
}
