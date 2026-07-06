import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { API_ROUTES } from "../constants.ts"
import { debugLog } from "../debug.ts"
import { createControlPanelApi, isUpdateJob } from "../services/controlPanelApi.ts"
import { createButton, ensureStyles } from "../ui/dom.ts"
import { createGitInstallModalController } from "./gitInstallModal.ts"
import type { JsonObject, ToastSeverity, UpdateJob } from "../types.ts"

type ControlPanelOptions = {
  app: ComfyApp
  readBooleanSetting: (id: string) => boolean
}

export type ControlPanelController = {
  open: () => void
  close: () => void
}

export function createControlPanelController(options: ControlPanelOptions): ControlPanelController {
  const { app, readBooleanSetting } = options
  const api = createControlPanelApi(app)

  let panelEl: HTMLElement | undefined
  let logEl: HTMLPreElement | undefined
  let restartNoticeEl: HTMLElement | undefined
  let statusPollTimer: number | undefined

  function toast(severity: ToastSeverity, summary: string, detail: string): void {
    app.extensionManager.toast.add({ severity, summary, detail, life: 5000 })
  }

  function scrollLogToBottom(): void {
    const currentLogEl = logEl
    if (!currentLogEl) {
      return
    }

    window.requestAnimationFrame(() => {
      currentLogEl.scrollTop = currentLogEl.scrollHeight
    })
  }

  function writeLog(message: string, payload?: unknown): void {
    if (!logEl) {
      return
    }

    const timestamp = new Date().toLocaleTimeString()
    const body = payload === undefined ? "" : `\n${JSON.stringify(payload, null, 2)}`
    logEl.textContent = `${logEl.textContent ?? ""}[${timestamp}] ${message}${body}\n\n`
    scrollLogToBottom()
  }

  function renderJob(job: UpdateJob): void {
    if (!logEl) {
      return
    }

    const logs = job.logs.length > 0 ? job.logs.join("\n") : `${job.label} is ${job.status}.`
    const error = job.error ? `\n\nError:\n${job.error}` : ""
    logEl.textContent = `${job.label} (${job.status})\n\n${logs}${error}\n`
    scrollLogToBottom()
    if (restartNoticeEl) {
      restartNoticeEl.hidden = !job.restart_required || job.status !== "succeeded"
    }
  }

  async function runOperation(label: string, route: string, body?: JsonObject): Promise<void> {
    writeLog(`${label} started.`)
    debugLog(readBooleanSetting, `${label} request`, { route, body })

    try {
      const data = await api.fetchJson(route, body)
      writeLog(`${label} completed.`, data)
      toast("success", "ComfyUI-ControlPanel", `${label} completed.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`${label} failed: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  const gitInstallModal = createGitInstallModalController({
    runOperation(label, route, body) {
      void runOperation(label, route, body)
    },
    toast,
  })

  function stopPolling(): void {
    if (statusPollTimer !== undefined) {
      window.clearInterval(statusPollTimer)
      statusPollTimer = undefined
    }
  }

  async function refreshUpdateStatus(): Promise<UpdateJob | undefined> {
    const data = await api.fetchJson(API_ROUTES.UPDATE_STATUS)
    const job = data.job
    if (!isUpdateJob(job)) {
      return undefined
    }
    renderJob(job)
    return job
  }

  function pollUpdateStatus(): void {
    stopPolling()
    statusPollTimer = window.setInterval(() => {
      void refreshUpdateStatus()
        .then((job) => {
          if (job && !["queued", "running"].includes(job.status)) {
            stopPolling()
            toast(job.status === "succeeded" ? "success" : "error", "ComfyUI-ControlPanel", `${job.label} ${job.status}.`)
          }
        })
        .catch((error) => {
          stopPolling()
          const message = error instanceof Error ? error.message : String(error)
          writeLog(`Status polling failed: ${message}`)
        })
    }, 1500)
  }

  async function startUpdateJob(label: string, route: string): Promise<void> {
    writeLog(`${label} queued.`)
    debugLog(readBooleanSetting, `${label} request`, { route })

    try {
      const data = await api.fetchJson(route, {})
      const job = data.job
      if (!isUpdateJob(job)) {
        throw new Error("Update job response was missing job details.")
      }
      renderJob(job)
      toast("info", "ComfyUI-ControlPanel", `${label} started.`)
      pollUpdateStatus()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`${label} failed to start: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  function createPanel(): HTMLElement {
    ensureStyles()

    const backdrop = document.createElement("div")
    backdrop.className = "cp-backdrop"
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close()
      }
    })

    const panel = document.createElement("section")
    panel.className = "cp-panel"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-modal", "true")
    panel.setAttribute("aria-labelledby", "cp-title")

    const header = document.createElement("div")
    header.className = "cp-header"

    const title = document.createElement("h2")
    title.id = "cp-title"
    title.className = "cp-title"
    title.textContent = "ComfyUI-ControlPanel"

    const closeButton = createButton("×", close, "cp-button cp-close")
    closeButton.setAttribute("aria-label", "Close")
    header.append(title, closeButton)

    const actions = document.createElement("div")
    actions.className = "cp-actions"
    actions.append(
      createButton("Install via Git URL", () => {
        gitInstallModal.open()
      }),
      createButton("Update Git Nodes", () => {
        void startUpdateJob("Update Git Nodes", API_ROUTES.UPDATE_CUSTOM_NODES)
      }),
      createButton("Sync Dependencies", () => {
        void startUpdateJob("Sync Dependencies", API_ROUTES.SYNC_DEPENDENCIES)
      }),
      createButton("Update ComfyUI", () => {
        void startUpdateJob("Update ComfyUI", API_ROUTES.UPDATE_COMFYUI)
      }),
      createButton("Restart", () => {
        if (window.confirm("Restart ComfyUI now?")) {
          void runOperation("Restart", API_ROUTES.RESTART, { confirm: true })
        }
      }, "cp-button cp-danger"),
    )

    restartNoticeEl = document.createElement("div")
    restartNoticeEl.className = "cp-restart-notice"
    restartNoticeEl.hidden = true
    restartNoticeEl.textContent = "Restart required to finish applying updates."

    logEl = document.createElement("pre")
    logEl.className = "cp-log"
    logEl.textContent = "Ready.\n"
    scrollLogToBottom()

    panel.append(header, actions, restartNoticeEl, logEl)
    backdrop.append(panel)
    return backdrop
  }

  function open(): void {
    if (!panelEl) {
      panelEl = createPanel()
    }
    if (!panelEl.isConnected) {
      document.body.append(panelEl)
    }
    void runOperation("Status", API_ROUTES.STATUS)
  }

  function close(): void {
    stopPolling()
    gitInstallModal.close()
    panelEl?.remove()
  }

  return { open, close }
}
