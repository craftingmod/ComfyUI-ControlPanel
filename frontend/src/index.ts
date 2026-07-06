import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { debugLog } from "./debug.ts"
import { API_ROUTES, EXTENSION_NAME, SETTINGS_IDS } from "./constants.ts"
import controlPanelStyles from "./styles.css?inline"

declare global {
  const app: ComfyApp

  interface Window {
    app: ComfyApp
    __COMFYUI_FRONTEND_VERSION__?: string
  }
}

type JsonObject = Record<string, unknown>
type ManagerExtension = Parameters<ComfyApp["registerExtension"]>[0]
type ComfyMenuButton = {
  element: HTMLElement
}
type ComfyMenuButtonGroup = {
  element: HTMLElement
}
type ComfyMenu = {
  actionsGroup?: {
    element?: HTMLElement
  }
  settingsGroup?: {
    element?: HTMLElement
  }
}
type ComfyButtonConstructor = new(options: {
  icon: string
  tooltip: string
  app: ComfyApp
  enabled: boolean
  classList: string
}) => ComfyMenuButton
type ComfyButtonGroupConstructor = new(button: ComfyMenuButton) => ComfyMenuButtonGroup
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

const TOP_MENU_BUTTON_GROUP_CLASS = "control-panel-top-menu-group"
const TOP_MENU_BUTTON_TOOLTIP = "Open ComfyUI-ControlPanel"
const MAX_TOP_MENU_ATTACH_ATTEMPTS = 120
const MIN_VERSION_FOR_ACTION_BAR = [1, 33, 9] as const

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
    toast("success", "ComfyUI-ControlPanel", `${label} completed.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeLog(`${label} failed: ${message}`)
    toast("error", "ComfyUI-ControlPanel", message)
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
    const data = await fetchJson(route, {})
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

function createButton(label: string, onClick: () => void, className = "cp-button"): HTMLButtonElement {
  const button = document.createElement("button")
  button.className = className
  button.type = "button"
  button.textContent = label
  button.addEventListener("click", onClick)
  return button
}

function ensureStyles(): void {
  if (document.getElementById("control-panel-styles")) {
    return
  }

  const style = document.createElement("style")
  style.id = "control-panel-styles"
  style.textContent = controlPanelStyles
  document.head.append(style)
}

function createPanel(): HTMLElement {
  ensureStyles()

  const backdrop = document.createElement("div")
  backdrop.className = "cp-backdrop"
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closePanel()
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

  const closeButton = createButton("×", closePanel, "cp-button cp-close")
  closeButton.setAttribute("aria-label", "Close")
  header.append(title, closeButton)

  const actions = document.createElement("div")
  actions.className = "cp-actions"
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
    }, "cp-button cp-danger"),
  )

  restartNoticeEl = document.createElement("div")
  restartNoticeEl.className = "cp-restart-notice"
  restartNoticeEl.hidden = true
  restartNoticeEl.textContent = "Restart required to finish applying updates."

  logEl = document.createElement("pre")
  logEl.className = "cp-log"
  logEl.textContent = "Ready.\n"

  panel.append(header, actions, restartNoticeEl, logEl)
  backdrop.append(panel)
  return backdrop
}

function createGitInstallModal(): HTMLElement {
  ensureStyles()

  const backdrop = document.createElement("div")
  backdrop.className = "cp-backdrop"
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeGitInstallModal()
    }
  })

  const panel = document.createElement("section")
  panel.className = "cp-panel cp-modal"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-modal", "true")
  panel.setAttribute("aria-labelledby", "cp-git-install-title")

  const header = document.createElement("div")
  header.className = "cp-header"

  const title = document.createElement("h2")
  title.id = "cp-git-install-title"
  title.className = "cp-title"
  title.textContent = "Install via Git URL"

  const closeButton = createButton("×", closeGitInstallModal, "cp-button cp-close")
  closeButton.setAttribute("aria-label", "Close")
  header.append(title, closeButton)

  const fields = document.createElement("div")
  fields.className = "cp-grid"

  const urlField = document.createElement("div")
  urlField.className = "cp-field cp-field-wide"
  const urlLabel = document.createElement("label")
  urlLabel.htmlFor = "cp-git-url"
  urlLabel.textContent = "Git URL"
  gitUrlInputEl = document.createElement("input")
  gitUrlInputEl.id = "cp-git-url"
  gitUrlInputEl.placeholder = "https://github.com/user/comfyui-node-pack.git"
  urlField.append(urlLabel, gitUrlInputEl)

  const nameField = document.createElement("div")
  nameField.className = "cp-field cp-field-wide"
  const nameLabel = document.createElement("label")
  nameLabel.htmlFor = "cp-folder-name"
  nameLabel.textContent = "Folder name"
  gitNameInputEl = document.createElement("input")
  gitNameInputEl.id = "cp-folder-name"
  gitNameInputEl.placeholder = "Optional"
  nameField.append(nameLabel, gitNameInputEl)
  fields.append(urlField, nameField)

  const actions = document.createElement("div")
  actions.className = "cp-modal-actions"
  actions.append(
    createButton("Cancel", closeGitInstallModal),
    createButton("Install", () => {
      const url = gitUrlInputEl?.value.trim() ?? ""
      const name = gitNameInputEl?.value.trim()
      if (!url) {
        toast("warn", "ComfyUI-ControlPanel", "Git URL is required.")
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

async function createTopMenuButton(): Promise<ComfyMenuButton> {
  const buttonModulePath = "../../scripts/ui/components/button.js"
  const { ComfyButton } = await import(/* @vite-ignore */ buttonModulePath) as {
    ComfyButton: ComfyButtonConstructor
  }
  const button = new ComfyButton({
    icon: "icon-[lucide--wrench]",
    tooltip: TOP_MENU_BUTTON_TOOLTIP,
    app,
    enabled: true,
    classList: "comfyui-button comfyui-menu-mobile-collapse",
  })
  button.element.setAttribute("aria-label", TOP_MENU_BUTTON_TOOLTIP)
  button.element.title = TOP_MENU_BUTTON_TOOLTIP
  button.element.addEventListener("click", openPanel)
  return button
}

async function attachTopMenuButton(attempt = 0): Promise<void> {
  if (document.querySelector(`.${TOP_MENU_BUTTON_GROUP_CLASS}`)) {
    return
  }

  const menu = (app as ComfyApp & { menu?: ComfyMenu }).menu
  const anchorGroupEl = menu?.actionsGroup?.element ?? menu?.settingsGroup?.element
  const parentEl = anchorGroupEl?.parentElement
  if (!anchorGroupEl || !parentEl) {
    if (attempt >= MAX_TOP_MENU_ATTACH_ATTEMPTS) {
      console.warn("ComfyUI-ControlPanel: unable to locate the ComfyUI action/settings button group.")
      return
    }
    window.requestAnimationFrame(() => {
      void attachTopMenuButton(attempt + 1)
    })
    return
  }

  const button = await createTopMenuButton()
  const groupModulePath = "../../scripts/ui/components/buttonGroup.js"
  const { ComfyButtonGroup } = await import(/* @vite-ignore */ groupModulePath) as {
    ComfyButtonGroup: ComfyButtonGroupConstructor
  }
  const buttonGroup = new ComfyButtonGroup(button)
  buttonGroup.element.classList.add(TOP_MENU_BUTTON_GROUP_CLASS)
  anchorGroupEl.before(buttonGroup.element)
}

function parseVersion(version: string): [number, number, number] {
  const cleanVersion = version.replace(/^[vV]/, "").split("-", 1)[0]
  const parts = cleanVersion.split(".").map((part) => Number.parseInt(part, 10) || 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function compareVersions(version: [number, number, number], minimum: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] > minimum[index]) {
      return 1
    }
    if (version[index] < minimum[index]) {
      return -1
    }
  }
  return 0
}

async function getComfyUIFrontendVersion(): Promise<string> {
  if (window.__COMFYUI_FRONTEND_VERSION__) {
    return window.__COMFYUI_FRONTEND_VERSION__
  }

  try {
    const response = await app.api.fetchApi("/system_stats")
    const data = await response.json() as {
      system?: {
        comfyui_frontend_version?: string
        required_frontend_version?: string
      }
    }
    return data.system?.comfyui_frontend_version ?? data.system?.required_frontend_version ?? "0.0.0"
  } catch (error) {
    console.warn("ComfyUI-ControlPanel: unable to read ComfyUI frontend version.", error)
    return "0.0.0"
  }
}

async function supportsActionBarButtons(): Promise<boolean> {
  return compareVersions(parseVersion(await getComfyUIFrontendVersion()), MIN_VERSION_FOR_ACTION_BAR) >= 0
}

function createExtensionObject(useActionBar: boolean): ManagerExtension {
  const extension: ManagerExtension = {
    name: EXTENSION_NAME,
    async setup() {
      await attachTopMenuButton()
    },
    commands: [
      {
        id: "control-panel.open",
        label: "ComfyUI-ControlPanel",
        icon: "pi pi-wrench",
        function: openPanel,
      },
    ],
    menuCommands: [
      {
        path: ["ComfyUI-ControlPanel"],
        commands: ["control-panel.open"],
      },
    ],
    settings: [
      {
        id: SETTINGS_IDS.VERSION,
        name: "ComfyUI-ControlPanel 1.0.0",
        type: () => {
          const spanEl = document.createElement("span")
          const linkEl = document.createElement("a")
          linkEl.href = "https://github.com/craftingmod/comfyui-control-panel"
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
  }

  if (useActionBar) {
    extension.actionBarButtons = [
      {
        icon: "icon-[lucide--wrench]",
        label: "Manager",
        tooltip: TOP_MENU_BUTTON_TOOLTIP,
        onClick: openPanel,
      },
    ]
  }

  return extension
}

void (async () => {
  app.registerExtension(createExtensionObject(await supportsActionBarButtons()))
})()
