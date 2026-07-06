import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { debugLog } from "./debug.ts"
import { API_ROUTES, EXTENSION_NAME, SETTINGS_IDS } from "./constants.ts"
import cmeStyles from "./styles.css?inline"

declare global {
  const app: ComfyApp

  interface Window {
    app: ComfyApp
  }
}

type JsonObject = Record<string, unknown>
type UpdateJob = {
  id: string
  label: string
  status: "queued" | "running" | "succeeded" | "failed"
  logs: string[]
  error?: string | null
  restart_required?: boolean
  result?: JsonObject | null
}

let panelEl: HTMLElement | undefined
let gitInstallModalEl: HTMLElement | undefined
let logEl: HTMLPreElement | undefined
let restartNoticeEl: HTMLElement | undefined
let gitUrlInputEl: HTMLInputElement | undefined
let gitNameInputEl: HTMLInputElement | undefined
let statusPollTimer: number | undefined

function getSetting<T>(id: string): T | undefined {
  return app.extensionManager.setting.get<T>(id)
}

function readBooleanSetting(id: string): boolean {
  return getSetting<boolean>(id) ?? false
}

function toast(severity: "success" | "info" | "warn" | "error", summary: string, detail: string): void {
  app.extensionManager.toast.add({ severity, summary, detail, life: 5000 })
}

function writeLog(message: string, payload?: unknown): void {
  if (!logEl) {
    return
  }

  const timestamp = new Date().toLocaleTimeString()
  const body = payload === undefined ? "" : `\n${JSON.stringify(payload, null, 2)}`
  logEl.textContent = `[${timestamp}] ${message}${body}\n\n${logEl.textContent ?? ""}`
}

function renderJob(job: UpdateJob): void {
  if (!logEl) {
    return
  }

  const logs = job.logs.length > 0 ? job.logs.join("\n") : `${job.label} is ${job.status}.`
  const error = job.error ? `\n\nError:\n${job.error}` : ""
  logEl.textContent = `${job.label} (${job.status})\n\n${logs}${error}\n`
  if (restartNoticeEl) {
    restartNoticeEl.hidden = !job.restart_required || job.status !== "succeeded"
  }
}

async function fetchJson(route: string, body?: JsonObject): Promise<JsonObject> {
  const response = await app.api.fetchApi(route, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = (await response.json()) as JsonObject
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.error ?? response.statusText))
  }
  return data
}

function isUpdateJob(value: unknown): value is UpdateJob {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as UpdateJob).id === "string"
    && typeof (value as UpdateJob).label === "string"
    && typeof (value as UpdateJob).status === "string",
  )
}

async function runOperation(label: string, route: string, body?: JsonObject): Promise<void> {
  writeLog(`${label} started.`)
  debugLog(readBooleanSetting, `${label} request`, { route, body })

  try {
    const data = await fetchJson(route, body)
    writeLog(`${label} completed.`, data)
    toast("success", "Manager Extension", `${label} completed.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeLog(`${label} failed: ${message}`)
    toast("error", "Manager Extension", message)
  }
}

function stopPolling(): void {
  if (statusPollTimer !== undefined) {
    window.clearInterval(statusPollTimer)
    statusPollTimer = undefined
  }
}

async function refreshUpdateStatus(): Promise<UpdateJob | undefined> {
  const data = await fetchJson(API_ROUTES.UPDATE_STATUS)
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
          toast(job.status === "succeeded" ? "success" : "error", "Manager Extension", `${job.label} ${job.status}.`)
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
    const data = await fetchJson(route, {})
    const job = data.job
    if (!isUpdateJob(job)) {
      throw new Error("Update job response was missing job details.")
    }
    renderJob(job)
    toast("info", "Manager Extension", `${label} started.`)
    pollUpdateStatus()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeLog(`${label} failed to start: ${message}`)
    toast("error", "Manager Extension", message)
  }
}

function createButton(label: string, onClick: () => void, className = "cme-button"): HTMLButtonElement {
  const button = document.createElement("button")
  button.className = className
  button.type = "button"
  button.textContent = label
  button.addEventListener("click", onClick)
  return button
}

function ensureStyles(): void {
  if (document.getElementById("manager-extension-styles")) {
    return
  }

  const style = document.createElement("style")
  style.id = "manager-extension-styles"
  style.textContent = cmeStyles
  document.head.append(style)
}

function createPanel(): HTMLElement {
  ensureStyles()

  const backdrop = document.createElement("div")
  backdrop.className = "cme-backdrop"
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closePanel()
    }
  })

  const panel = document.createElement("section")
  panel.className = "cme-panel"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-modal", "true")
  panel.setAttribute("aria-labelledby", "cme-title")

  const header = document.createElement("div")
  header.className = "cme-header"

  const title = document.createElement("h2")
  title.id = "cme-title"
  title.className = "cme-title"
  title.textContent = "Manager Extension"

  const closeButton = createButton("×", closePanel, "cme-button cme-close")
  closeButton.setAttribute("aria-label", "Close")
  header.append(title, closeButton)

  const actions = document.createElement("div")
  actions.className = "cme-actions"
  actions.append(
    createButton("Install via Git URL", () => {
      openGitInstallModal()
    }),
    createButton("Update Custom Nodes", () => {
      void startUpdateJob("Update Custom Nodes", API_ROUTES.UPDATE_CUSTOM_NODES)
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
    }, "cme-button cme-danger"),
  )

  restartNoticeEl = document.createElement("div")
  restartNoticeEl.className = "cme-restart-notice"
  restartNoticeEl.hidden = true
  restartNoticeEl.textContent = "Restart required to finish applying updates."

  logEl = document.createElement("pre")
  logEl.className = "cme-log"
  logEl.textContent = "Ready.\n"

  panel.append(header, actions, restartNoticeEl, logEl)
  backdrop.append(panel)
  return backdrop
}

function createGitInstallModal(): HTMLElement {
  ensureStyles()

  const backdrop = document.createElement("div")
  backdrop.className = "cme-backdrop"
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeGitInstallModal()
    }
  })

  const panel = document.createElement("section")
  panel.className = "cme-panel cme-modal"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-modal", "true")
  panel.setAttribute("aria-labelledby", "cme-git-install-title")

  const header = document.createElement("div")
  header.className = "cme-header"

  const title = document.createElement("h2")
  title.id = "cme-git-install-title"
  title.className = "cme-title"
  title.textContent = "Install via Git URL"

  const closeButton = createButton("×", closeGitInstallModal, "cme-button cme-close")
  closeButton.setAttribute("aria-label", "Close")
  header.append(title, closeButton)

  const fields = document.createElement("div")
  fields.className = "cme-grid"

  const urlField = document.createElement("div")
  urlField.className = "cme-field cme-field-wide"
  const urlLabel = document.createElement("label")
  urlLabel.htmlFor = "cme-git-url"
  urlLabel.textContent = "Git URL"
  gitUrlInputEl = document.createElement("input")
  gitUrlInputEl.id = "cme-git-url"
  gitUrlInputEl.placeholder = "https://github.com/user/comfyui-node-pack.git"
  urlField.append(urlLabel, gitUrlInputEl)

  const nameField = document.createElement("div")
  nameField.className = "cme-field cme-field-wide"
  const nameLabel = document.createElement("label")
  nameLabel.htmlFor = "cme-folder-name"
  nameLabel.textContent = "Folder name"
  gitNameInputEl = document.createElement("input")
  gitNameInputEl.id = "cme-folder-name"
  gitNameInputEl.placeholder = "Optional"
  nameField.append(nameLabel, gitNameInputEl)
  fields.append(urlField, nameField)

  const actions = document.createElement("div")
  actions.className = "cme-modal-actions"
  actions.append(
    createButton("Cancel", closeGitInstallModal),
    createButton("Install", () => {
      const url = gitUrlInputEl?.value.trim() ?? ""
      const name = gitNameInputEl?.value.trim()
      if (!url) {
        toast("warn", "Manager Extension", "Git URL is required.")
        gitUrlInputEl?.focus()
        return
      }
      closeGitInstallModal()
      void runOperation("Install via Git URL", API_ROUTES.INSTALL_GIT_URL, { url, ...(name ? { name } : {}) })
    }),
  )

  panel.append(header, fields, actions)
  backdrop.append(panel)
  return backdrop
}

function openPanel(): void {
  if (!panelEl) {
    panelEl = createPanel()
  }
  if (!panelEl.isConnected) {
    document.body.append(panelEl)
  }
  void runOperation("Status", API_ROUTES.STATUS)
}

function closePanel(): void {
  stopPolling()
  closeGitInstallModal()
  panelEl?.remove()
}

function openGitInstallModal(): void {
  if (!gitInstallModalEl) {
    gitInstallModalEl = createGitInstallModal()
  }
  if (!gitInstallModalEl.isConnected) {
    document.body.append(gitInstallModalEl)
  }
  gitUrlInputEl?.focus()
}

function closeGitInstallModal(): void {
  gitInstallModalEl?.remove()
}

app.registerExtension({
  name: EXTENSION_NAME,
  commands: [
    {
      id: "manager-extension.open",
      label: "Manager Extension",
      icon: "pi pi-wrench",
      function: openPanel,
    },
  ],
  menuCommands: [
    {
      path: ["Manager Extension"],
      commands: ["manager-extension.open"],
    },
  ],
  actionBarButtons: [
    {
      icon: "pi pi-wrench",
      label: "Manager",
      tooltip: "Open Manager Extension",
      onClick: openPanel,
    },
  ],
  settings: [
    {
      id: SETTINGS_IDS.VERSION,
      name: "Manager Extension 1.0.0",
      type: () => {
        const spanEl = document.createElement("span")
        const linkEl = document.createElement("a")
        linkEl.href = "https://github.com/craftingmod/comfyui-manager-extension"
        linkEl.target = "_blank"
        linkEl.rel = "noopener noreferrer"
        linkEl.textContent = "Homepage"
        linkEl.style.paddingRight = "12px"
        spanEl.append(linkEl)
        return spanEl
      },
      defaultValue: undefined,
    },
    {
      id: SETTINGS_IDS.DEBUG_LOGGING,
      name: "Enable Debug Logging",
      type: "boolean",
      tooltip: "Show detailed debug logs in browser console during manager operations",
      defaultValue: false,
    },
  ],
})
