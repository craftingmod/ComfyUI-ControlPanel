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

type OperationOptions = {
  toastOnSuccess?: boolean
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

  function asRecord(value: unknown): JsonObject | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined
    }
    return value as JsonObject
  }

  function formatGitInstallResult(data: JsonObject): string | undefined {
    const install = asRecord(data.install)
    const destination = typeof install?.destination === "string" ? install.destination : undefined
    const result = asRecord(install?.result)
    const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : ""
    const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : ""

    if (!destination && !stdout && !stderr) {
      return undefined
    }

    const lines = ["Install via Git URL completed."]
    if (destination) {
      const pathParts = destination.split(/[\\/]/).filter(Boolean)
      const folderName = pathParts[pathParts.length - 1] ?? destination
      lines.push(`Installed: ${folderName}`)
      lines.push(`Path: ${destination}`)
    }
    if (stdout) {
      lines.push("", stdout)
    }
    if (stderr) {
      lines.push("", stderr)
    }
    return lines.join("\n")
  }

  function formatOperationResult(label: string, route: string, data: JsonObject): string | undefined {
    if (route === API_ROUTES.INSTALL_GIT_URL) {
      return formatGitInstallResult(data)
    }
    return `${label} completed.\n${JSON.stringify(data, null, 2)}`
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

  async function runOperation(label: string, route: string, body?: JsonObject, operationOptions: OperationOptions = {}): Promise<void> {
    const { toastOnSuccess = true } = operationOptions
    writeLog(`${label} started.`)
    debugLog(readBooleanSetting, `${label} request`, { route, body })

    try {
      const data = await api.fetchJson(route, body)
      writeLog(formatOperationResult(label, route, data) ?? `${label} completed.`, undefined)
      if (toastOnSuccess) {
        toast("success", "ComfyUI-ControlPanel", `${label} completed.`)
      }
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

  async function confirmRestart(): Promise<void> {
    const confirmed = await app.extensionManager.dialog.confirm({
      title: "Restart ComfyUI",
      message: "Restart ComfyUI now?",
    })
    if (confirmed) {
      await restartComfyUI()
    }
  }

  async function restartComfyUI(): Promise<void> {
    const label = "Restart"
    const body = { confirm: true }
    writeLog(`${label} started.`)
    debugLog(readBooleanSetting, `${label} request`, { route: API_ROUTES.RESTART, body })

    try {
      const data = await api.fetchJson(API_ROUTES.RESTART, body)
      writeLog(formatOperationResult(label, API_ROUTES.RESTART, data) ?? `${label} completed.`, undefined)
      toast("info", "ComfyUI-ControlPanel", "Restarting")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`${label} failed: ${message}`)
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
    title.textContent = "⚙️ ComfyUI-ControlPanel"

    const closeButton = createButton("×", close, "cp-button cp-close")
    closeButton.setAttribute("aria-label", "Close")
    header.append(title, closeButton)

    const maintenanceActions = document.createElement("div")
    maintenanceActions.className = "cp-action-group"
    maintenanceActions.setAttribute("aria-label", "Maintenance actions")
    maintenanceActions.append(
      createButton("Install via Git URL", () => {
        gitInstallModal.open()
      }),
      createButton("Update Git Nodes", () => {
        void startUpdateJob("Update Git Nodes", API_ROUTES.UPDATE_CUSTOM_NODES)
      }),
      createButton("Update ComfyUI", () => {
        void startUpdateJob("Update ComfyUI", API_ROUTES.UPDATE_COMFYUI)
      }),
      createButton("Sync Dependencies", () => {
        void startUpdateJob("Sync Dependencies", API_ROUTES.SYNC_DEPENDENCIES)
      }),
    )

    const actions = document.createElement("div")
    actions.className = "cp-actions"
    actions.append(
      createButton("Update Manager Cache", () => {
        void startUpdateJob("Update Manager Cache", API_ROUTES.REFRESH_MANAGER_CACHE)
      }),
      createButton("Rebuild Manager Cache", () => {
        void startUpdateJob("Rebuild Manager Cache", API_ROUTES.REBUILD_MANAGER_CACHE)
      }),
      createButton("Restart", () => {
        void confirmRestart()
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

    panel.append(header, maintenanceActions, actions, restartNoticeEl, logEl)
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
    void runOperation("Status", API_ROUTES.STATUS, undefined, { toastOnSuccess: false })
  }

  function close(): void {
    stopPolling()
    gitInstallModal.close()
    panelEl?.remove()
  }

  return { open, close }
}
