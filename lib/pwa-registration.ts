export function pwaServiceWorkerAction(nodeEnv: string): "register" | "unregister" {
  return nodeEnv === "production" ? "register" : "unregister";
}
