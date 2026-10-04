import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import type { createTranslator } from "../i18n/messages.ts"

export async function restartWithManager(
  app: ComfyApp,
  t: ReturnType<typeof createTranslator>,
): Promise<void> {
  const abort = new AbortController()
  let disconnected = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onReconnected = () => {}
  const onReconnecting = () => {
    disconnected = true
  }

  try {
    await new Promise<void>((resolve, reject) => {
      onReconnected = () => {
        if (disconnected) resolve()
      }
      app.api.addEventListener("reconnecting", onReconnecting)
      app.api.addEventListener("reconnected", onReconnected)
      timer = setTimeout(() => reject(new Error(t("error.restartReconnectTimeout"))), 120_000)

      async function request(): Promise<void> {
        for (const route of ["/v2/manager/reboot", "/manager/reboot"]) {
          const response = await app.api.fetchApi(route, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: abort.signal,
          })
          if (response.status === 404) continue
          if (response.status === 403) throw new Error(t("error.managerRestartForbidden"))
          if (!response.ok) throw new Error(`HTTP ${response.status} for ${route}`)
          return
        }
        throw new Error(t("error.managerRestartUnavailable"))
      }

      void request().catch((error: unknown) => {
        // Manager may replace the process before sending an HTTP response.
        // A fetch network error is only successful after a disconnect/reconnect cycle.
        if (!(error instanceof TypeError)) reject(error)
      })
    })
  } finally {
    clearTimeout(timer)
    abort.abort()
    app.api.removeEventListener("reconnecting", onReconnecting)
    app.api.removeEventListener("reconnected", onReconnected)
  }
}
