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
  let managerCacheStatusEl: HTMLElement | undefined
  let managerCacheButtons: HTMLButtonElement[] = []
  let snapshotRestoreModalEl: HTMLElement | undefined
  let snapshotSelectEl: HTMLSelectElement | undefined
  let environmentModalEl: HTMLElement | undefined
  let environmentOutputEl: HTMLElement | undefined
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

  function clearLog(): void {
    if (!logEl) {
      return
    }
    logEl.textContent = "Ready.\n"
    scrollLogToBottom()
  }

  function createActionGroup(titleText: string, ariaLabel: string): HTMLDivElement {
    const group = document.createElement("div")
    group.className = "cp-action-group"
    group.setAttribute("aria-label", ariaLabel)

    const title = document.createElement("h3")
    title.className = "cp-group-title"
    title.textContent = titleText
    group.append(title)
    return group
  }

  function setManagerCacheControlsEnabled(enabled: boolean, message: string): void {
    for (const button of managerCacheButtons) {
      button.disabled = !enabled
    }
    if (managerCacheStatusEl) {
      managerCacheStatusEl.textContent = message
      managerCacheStatusEl.classList.toggle("cp-group-status-disabled", !enabled)
    }
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

  async function runOperation(label: string, route: string, body?: JsonObject, operationOptions: OperationOptions = {}): Promise<JsonObject | undefined> {
    const { toastOnSuccess = true } = operationOptions
    writeLog(`${label} started.`)
    debugLog(readBooleanSetting, `${label} request`, { route, body })

    try {
      const data = await api.fetchJson(route, body)
      writeLog(formatOperationResult(label, route, data) ?? `${label} completed.`, undefined)
      if (toastOnSuccess) {
        toast("success", "ComfyUI-ControlPanel", `${label} completed.`)
      }
      return data
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`${label} failed: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
      return undefined
    }
  }

  async function fetchStatus(): Promise<JsonObject> {
    debugLog(readBooleanSetting, "Status request", { route: API_ROUTES.STATUS })
    return await api.fetchJson(API_ROUTES.STATUS)
  }

  async function refreshPanelStatus(): Promise<void> {
    try {
      const data = await fetchStatus()
      const settings = asRecord(data.settings)
      const managerCacheEnabled = settings?.manager_repository_data_override === true
      setManagerCacheControlsEnabled(
        managerCacheEnabled,
        managerCacheEnabled
          ? "Replace Manager Repository Data is enabled."
          : "Enable Replace Manager Repository Data in settings to use these actions.",
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setManagerCacheControlsEnabled(false, "Status check failed. See the log for details.")
      writeLog(`Status check failed: ${message}`)
    }
  }

  async function showStatusJson(): Promise<void> {
    writeLog("Status JSON started.")
    try {
      const data = await fetchStatus()
      writeLog("Status JSON completed.", data)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`Status JSON failed: ${message}`)
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

  async function startUpdateJob(label: string, route: string, body: JsonObject = {}): Promise<void> {
    writeLog(`${label} queued.`)
    debugLog(readBooleanSetting, `${label} request`, { route, body })

    try {
      const data = await api.fetchJson(route, body)
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

  function closeSnapshotRestoreModal(): void {
    snapshotRestoreModalEl?.remove()
  }

  function closeEnvironmentModal(): void {
    environmentModalEl?.remove()
  }

  function snapshotNamesFromResponse(data: JsonObject): string[] {
    const snapshots = Array.isArray(data.snapshots) ? data.snapshots : []
    return snapshots
      .map((snapshot) => asRecord(snapshot)?.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
  }

  async function openSnapshotRestoreModal(): Promise<void> {
    writeLog("Snapshot List started.")
    try {
      const data = await api.fetchJson(API_ROUTES.SNAPSHOT_LIST)
      const names = snapshotNamesFromResponse(data)
      writeLog(`Snapshot List completed.\n${JSON.stringify(data, null, 2)}`)
      if (names.length === 0) {
        toast("warn", "ComfyUI-ControlPanel", "No snapshots were found.")
        return
      }
      snapshotRestoreModalEl?.remove()
      snapshotRestoreModalEl = createSnapshotRestoreModal(names)
      document.body.append(snapshotRestoreModalEl)
      snapshotSelectEl?.focus()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`Snapshot List failed: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  async function confirmRestoreSnapshot(): Promise<void> {
    const target = snapshotSelectEl?.value
    if (!target) {
      toast("warn", "ComfyUI-ControlPanel", "Select a snapshot to restore.")
      return
    }

    const confirmed = await app.extensionManager.dialog.confirm({
      title: "Restore Snapshot",
      message: `Restoring "${target}" may change installed custom nodes and dependencies. Continue?`,
    })
    if (confirmed) {
      closeSnapshotRestoreModal()
      await startUpdateJob("Restore Snapshot", API_ROUTES.SNAPSHOT_RESTORE, { target })
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

  async function confirmRebuildManagerCache(): Promise<void> {
    const confirmed = await app.extensionManager.dialog.confirm({
      title: "Rebuild Manager Cache",
      message: "Rebuilding the Manager cache may take some time. Continue?",
    })
    if (confirmed) {
      await startUpdateJob("Rebuild Manager Cache", API_ROUTES.REBUILD_MANAGER_CACHE)
    }
  }

  type EnvironmentSection = {
    title: string
    rows: Array<[string, unknown]>
  }

  function environmentSections(data: JsonObject): EnvironmentSection[] | undefined {
    const environment = asRecord(data.environment)
    if (!environment) {
      return undefined
    }

    const cli = asRecord(data.cli)
    const python = asRecord(environment.python)
    const config = asRecord(environment.config)
    const server = asRecord(environment.server)
    const workspace = asRecord(environment.workspace)
    return [
      {
        title: "Comfy CLI",
        rows: [
          ["Version", cli?.version],
          ["Command", cli?.command],
        ],
      },
      {
        title: "Python",
        rows: [
          ["Python Version", python?.version],
          ["Python Executable", python?.executable],
          ["Virtualenv Path", python?.virtualenv],
          ["Conda Env", python?.conda_env],
        ],
      },
      {
        title: "Workspace",
        rows: [
          ["Current selected workspace", workspace?.path],
          ["Workspace Type", workspace?.type],
          ["Manager", workspace?.manager_mode],
          ["UV Compile Default", workspace?.uv_compile_default],
        ],
      },
      {
        title: "Server",
        rows: [
          ["Comfy Server Running", server?.running],
          ["Server URL", server?.url],
        ],
      },
      {
        title: "Config",
        rows: [
          ["Config Path", config?.path],
          ["Default ComfyUI workspace", config?.default_workspace],
          ["Default ComfyUI launch extra options", config?.default_launch_extras],
          ["Recent ComfyUI workspace", config?.recent_workspace],
          ["Tracking Analytics", config?.tracking_enabled],
          ["Background ComfyUI", config?.background],
        ],
      },
    ]
  }

  function environmentValueText(value: unknown): string {
    if (value === null || value === undefined || value === "") {
      return "Not set"
    }
    if (typeof value === "boolean") {
      return value ? "Yes" : "No"
    }
    return String(value)
  }

  function renderEnvironmentOutput(data: JsonObject): void {
    if (!environmentOutputEl) {
      return
    }
    environmentOutputEl.replaceChildren()
    const sections = environmentSections(data)
    if (!sections) {
      const fallback = document.createElement("pre")
      fallback.className = "cp-environment-fallback"
      fallback.textContent = JSON.stringify(data, null, 2)
      environmentOutputEl.append(fallback)
      return
    }

    const table = document.createElement("table")
    table.className = "cp-environment-table"

    const thead = document.createElement("thead")
    const headerRow = document.createElement("tr")
    for (const label of ["Environment", "Value"]) {
      const cell = document.createElement("th")
      cell.scope = "col"
      cell.textContent = label
      headerRow.append(cell)
    }
    thead.append(headerRow)
    table.append(thead)

    const tbody = document.createElement("tbody")
    for (const section of sections) {
      const sectionRow = document.createElement("tr")
      sectionRow.className = "cp-environment-section-row"
      const sectionCell = document.createElement("th")
      sectionCell.scope = "rowgroup"
      sectionCell.colSpan = 2
      sectionCell.textContent = section.title
      sectionRow.append(sectionCell)
      tbody.append(sectionRow)

      for (const [label, value] of section.rows) {
        const row = document.createElement("tr")
        const keyCell = document.createElement("th")
        keyCell.scope = "row"
        keyCell.textContent = label
        const valueCell = document.createElement("td")
        valueCell.textContent = environmentValueText(value)
        row.append(keyCell, valueCell)
        tbody.append(row)
      }
    }
    table.append(tbody)
    environmentOutputEl.append(table)

    const result = asRecord(data.result)
    const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : ""
    if (stderr) {
      const error = document.createElement("pre")
      error.className = "cp-environment-fallback cp-environment-stderr"
      error.textContent = `stderr\n${stderr}`
      environmentOutputEl.append(error)
    }
  }

  async function showEnvironment(): Promise<void> {
    environmentModalEl?.remove()
    environmentModalEl = createEnvironmentModal()
    document.body.append(environmentModalEl)
    if (environmentOutputEl) {
      environmentOutputEl.textContent = "Loading comfy env..."
    }
    writeLog("Show Environment started.")

    try {
      const data = await api.fetchJson(API_ROUTES.SHOW_ENVIRONMENT, {})
      renderEnvironmentOutput(data)
      writeLog("Show Environment completed.")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (environmentOutputEl) {
        environmentOutputEl.textContent = message
      }
      writeLog(`Show Environment failed: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
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

  function createSnapshotRestoreModal(snapshotNames: string[]): HTMLElement {
    ensureStyles()

    const backdrop = document.createElement("div")
    backdrop.className = "cp-backdrop"
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        closeSnapshotRestoreModal()
      }
    })

    const panel = document.createElement("section")
    panel.className = "cp-panel cp-modal"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-modal", "true")
    panel.setAttribute("aria-labelledby", "cp-snapshot-restore-title")

    const header = document.createElement("div")
    header.className = "cp-header"

    const title = document.createElement("h2")
    title.id = "cp-snapshot-restore-title"
    title.className = "cp-title"
    title.textContent = "Restore Snapshot"

    const closeButton = createButton("×", closeSnapshotRestoreModal, "cp-button cp-close")
    closeButton.setAttribute("aria-label", "Close")
    header.append(title, closeButton)

    const field = document.createElement("div")
    field.className = "cp-field"
    const label = document.createElement("label")
    label.htmlFor = "cp-snapshot-select"
    label.textContent = "Snapshot"
    snapshotSelectEl = document.createElement("select")
    snapshotSelectEl.id = "cp-snapshot-select"
    for (const name of snapshotNames) {
      const option = document.createElement("option")
      option.value = name
      option.textContent = name
      snapshotSelectEl.append(option)
    }
    field.append(label, snapshotSelectEl)

    const actions = document.createElement("div")
    actions.className = "cp-modal-actions"
    actions.append(
      createButton("Cancel", closeSnapshotRestoreModal),
      createButton("Restore", () => {
        void confirmRestoreSnapshot()
      }, "cp-button cp-danger"),
    )

    panel.append(header, field, actions)
    backdrop.append(panel)
    return backdrop
  }

  function createEnvironmentModal(): HTMLElement {
    ensureStyles()

    const backdrop = document.createElement("div")
    backdrop.className = "cp-backdrop"
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        closeEnvironmentModal()
      }
    })

    const panel = document.createElement("section")
    panel.className = "cp-panel cp-modal cp-environment-modal"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-modal", "true")
    panel.setAttribute("aria-labelledby", "cp-environment-title")

    const header = document.createElement("div")
    header.className = "cp-header"

    const title = document.createElement("h2")
    title.id = "cp-environment-title"
    title.className = "cp-title"
    title.textContent = "Comfy CLI Environment"

    const closeButton = createButton("×", closeEnvironmentModal, "cp-button cp-close")
    closeButton.setAttribute("aria-label", "Close")
    header.append(title, closeButton)

    environmentOutputEl = document.createElement("div")
    environmentOutputEl.className = "cp-environment-output"
    environmentOutputEl.textContent = "Loading comfy env..."

    panel.append(header, environmentOutputEl)
    backdrop.append(panel)
    return backdrop
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

    const maintenanceActions = createActionGroup("Install / Update", "Install and update actions")
    maintenanceActions.append(
      createButton("Install via Git URL", () => {
        gitInstallModal.open()
      }),
      createButton("Sync Dependencies", () => {
        void startUpdateJob("Sync Dependencies", API_ROUTES.SYNC_DEPENDENCIES)
      }),
      createButton("Update ComfyUI", () => {
        void startUpdateJob("Update ComfyUI", API_ROUTES.UPDATE_COMFYUI)
      }),
      createButton("Update Git Nodes", () => {
        void startUpdateJob("Update Git Nodes", API_ROUTES.UPDATE_CUSTOM_NODES)
      }),
    )

    const cacheActions = createActionGroup("Manager Cache", "Manager cache actions")
    managerCacheStatusEl = document.createElement("div")
    managerCacheStatusEl.className = "cp-group-status cp-group-status-disabled"
    managerCacheStatusEl.textContent = "Checking Replace Manager Repository Data setting..."

    const updateManagerCacheButton = createButton("Update Manager Cache", () => {
      void startUpdateJob("Update Manager Cache", API_ROUTES.REFRESH_MANAGER_CACHE)
    })
    const rebuildManagerCacheButton = createButton("Rebuild Manager Cache", () => {
      void confirmRebuildManagerCache()
    })
    managerCacheButtons = [updateManagerCacheButton, rebuildManagerCacheButton]
    setManagerCacheControlsEnabled(false, "Checking Replace Manager Repository Data setting...")
    cacheActions.append(managerCacheStatusEl, updateManagerCacheButton, rebuildManagerCacheButton)

    const snapshotActions = createActionGroup("Snapshot", "Snapshot actions")
    snapshotActions.append(
      createButton("Save Snapshot", () => {
        void startUpdateJob("Save Snapshot", API_ROUTES.SNAPSHOT_SAVE)
      }),
      createButton("Restore Snapshot", () => {
        void openSnapshotRestoreModal()
      }, "cp-button cp-danger"),
      createButton("Open Snapshots Folder", () => {
        void runOperation("Open Snapshots Folder", API_ROUTES.OPEN_SNAPSHOTS, {})
      }),
      createButton("Open custom_nodes Folder", () => {
        void runOperation("Open custom_nodes Folder", API_ROUTES.OPEN_CUSTOM_NODES, {})
      }),
    )

    const actions = document.createElement("div")
    actions.className = "cp-actions"
    actions.append(
      createButton("Show Environment", () => {
        void showEnvironment()
      }),
      createButton("Restart", () => {
        void confirmRestart()
      }, "cp-button cp-danger"),
    )

    restartNoticeEl = document.createElement("div")
    restartNoticeEl.className = "cp-restart-notice"
    restartNoticeEl.hidden = true
    restartNoticeEl.textContent = "Restart required to finish applying updates."

    const logWrap = document.createElement("div")
    logWrap.className = "cp-log-wrap"

    const logActions = document.createElement("div")
    logActions.className = "cp-log-actions"
    const showStatusButton = createButton("Show Status", () => {
      void showStatusJson()
    }, "cp-button cp-log-action")
    showStatusButton.setAttribute("aria-label", "Show status JSON")

    const clearLogButton = createButton("Clear Log", clearLog, "cp-button cp-log-clear")
    clearLogButton.setAttribute("aria-label", "Clear log")
    logActions.append(showStatusButton, clearLogButton)

    logEl = document.createElement("pre")
    logEl.className = "cp-log"
    logEl.textContent = "Ready.\n"
    logWrap.append(logActions, logEl)
    scrollLogToBottom()

    panel.append(header, maintenanceActions, cacheActions, snapshotActions, actions, restartNoticeEl, logWrap)
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
    void refreshPanelStatus()
  }

  function close(): void {
    stopPolling()
    gitInstallModal.close()
    closeSnapshotRestoreModal()
    closeEnvironmentModal()
    panelEl?.remove()
  }

  return { open, close }
}
