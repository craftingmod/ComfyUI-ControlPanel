import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { createElement } from "react"
import { createRoot, type Root } from "react-dom/client"

import { API_ROUTES } from "../constants.ts"
import { debugLog } from "../debug.ts"
import { ControlPanelPage } from "../pages/ControlPanelPage.tsx"
import { fetchInstalledPackages } from "../services/cnrMetadata.ts"
import type { FixMetadataSummary } from "../services/cnrMetadataController.ts"
import { createControlPanelApi, isUpdateJob } from "../services/controlPanelApi.ts"
import {
  buildNodeRestoreManifest,
  dependencySyncNotice,
  parseNodeRestoreManifest,
} from "../services/nodeRestore.ts"
import { createNodesManagerController } from "../services/nodesManagerController.ts"
import type { JsonObject, ToastSeverity, UpdateJob } from "../types.ts"
import type { ControlPanelActions, ControlPanelViewState } from "./controlPanelTypes.ts"

type ControlPanelOptions = {
  app: ComfyApp
  readBooleanSetting: (id: string) => boolean
  fixCnrId: () => Promise<FixMetadataSummary | undefined>
}

type JobOutput = "panel" | "update-check"

export type ControlPanelController = ControlPanelActions & {
  open: () => void
}

export function createControlPanelController(options: ControlPanelOptions): ControlPanelController {
  const { app, readBooleanSetting } = options
  const api = createControlPanelApi(app)
  const nodesManager = createNodesManagerController(app)
  const listeners = new Set<() => void>()
  const dependencySyncNotifiedJobs = new Set<string>()
  let viewState: ControlPanelViewState = {
    isOpen: false,
    log: "Ready.\n",
    managerCacheControlsEnabled: false,
    managerCacheStatus: "Checking Replace Manager Repository Data setting...",
    updateCheckOutput: "Preparing update check...",
  }
  let host: HTMLDivElement | undefined
  let root: Root | undefined
  let statusPollTimer: number | undefined
  let panelGeneration = 0
  let snapshotRequestGeneration = 0

  function setViewState(patch: Partial<ControlPanelViewState>): void {
    viewState = { ...viewState, ...patch }
    for (const listener of listeners) listener()
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function toast(severity: ToastSeverity, summary: string, detail: string): void {
    app.extensionManager.toast.add({ severity, summary, detail, life: 5000 })
  }

  function asRecord(value: unknown): JsonObject | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as JsonObject
  }

  function formatGitInstallResult(data: JsonObject): string | undefined {
    const install = asRecord(data.install)
    const destination = typeof install?.destination === "string" ? install.destination : undefined
    const result = asRecord(install?.result)
    const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : ""
    const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : ""
    if (!destination && !stdout && !stderr) return undefined

    const lines = ["Install via Git URL completed."]
    if (destination) {
      const pathParts = destination.split(/[\\/]/).filter(Boolean)
      const folderName = pathParts[pathParts.length - 1] ?? destination
      lines.push(`Installed: ${folderName}`)
      lines.push(`Path: ${destination}`)
    }
    if (stdout) lines.push("", stdout)
    if (stderr) lines.push("", stderr)
    return lines.join("\n")
  }

  function formatOperationResult(
    label: string,
    route: string,
    data: JsonObject,
  ): string | undefined {
    if (route === API_ROUTES.INSTALL_GIT_URL) return formatGitInstallResult(data)
    return `${label} completed.\n${JSON.stringify(data, null, 2)}`
  }

  function writeLog(message: string, payload?: unknown): void {
    const timestamp = new Date().toLocaleTimeString()
    const body = payload === undefined ? "" : `\n${JSON.stringify(payload, null, 2)}`
    setViewState({ log: `${viewState.log}[${timestamp}] ${message}${body}\n\n` })
  }

  function clearLog(): void {
    setViewState({ log: "Ready.\n" })
  }

  function renderJob(job: UpdateJob): void {
    const logs = job.logs.length > 0 ? job.logs.join("\n") : `${job.label} is ${job.status}.`
    const error = job.error ? `\n\nError:\n${job.error}` : ""
    const syncNotice = job.status === "succeeded" ? dependencySyncNotice(job.result) : undefined
    const requiredAction = syncNotice ? `\n\nAction required:\n${syncNotice}` : ""
    setViewState({
      log: `${job.label} (${job.status})\n\n${logs}${error}${requiredAction}\n`,
      restartNotice:
        job.restart_required && job.status === "succeeded"
          ? (syncNotice ?? "Restart required to finish applying updates.")
          : undefined,
    })
    if (syncNotice && !dependencySyncNotifiedJobs.has(job.id)) {
      dependencySyncNotifiedJobs.add(job.id)
      toast("warn", "Dependency Sync Required", syncNotice)
    }
  }

  function renderUpdateCheckJob(job: UpdateJob): void {
    const logs = job.logs.length > 0 ? job.logs.join("\n") : `${job.label} is ${job.status}.`
    const error = job.error ? `\n\nError:\n${job.error}` : ""
    setViewState({ updateCheckOutput: `${job.label} (${job.status})\n\n${logs}${error}` })
  }

  function renderJobFor(output: JobOutput, job: UpdateJob): void {
    if (output === "update-check") renderUpdateCheckJob(job)
    else renderJob(job)
  }

  async function runOperation(
    label: string,
    route: string,
    body?: JsonObject,
  ): Promise<JsonObject | undefined> {
    writeLog(`${label} started.`)
    debugLog(readBooleanSetting, `${label} request`, { route, body })
    try {
      const data = await api.fetchJson(route, body)
      writeLog(formatOperationResult(label, route, data) ?? `${label} completed.`)
      toast("success", "ComfyUI-ControlPanel", `${label} completed.`)
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
      setViewState({
        managerCacheControlsEnabled: managerCacheEnabled,
        managerCacheStatus: managerCacheEnabled
          ? "Replace Manager Repository Data is enabled."
          : "Enable Replace Manager Repository Data in settings to use these actions.",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setViewState({
        managerCacheControlsEnabled: false,
        managerCacheStatus: "Status check failed. See the log for details.",
      })
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

  async function repairMetadata(): Promise<void> {
    writeLog("Repair Metadata started.")
    const summary = await options.fixCnrId()
    if (!summary) {
      writeLog("Repair Metadata stopped because metadata APIs were unavailable.")
      return
    }
    writeLog("Repair Metadata completed.", {
      updated: summary.updated,
      already_correct: summary.alreadyCorrect,
      unresolved: summary.unresolved,
      skipped: summary.skipped,
      conflicts_preserved: summary.conflictsPreserved,
      unresolved_nodes: summary.unresolvedNodes,
    })
  }

  function stopPolling(): void {
    if (statusPollTimer !== undefined) {
      window.clearInterval(statusPollTimer)
      statusPollTimer = undefined
    }
  }

  async function refreshUpdateStatus(
    output: JobOutput,
    generation: number,
  ): Promise<UpdateJob | undefined> {
    const data = await api.fetchJson(API_ROUTES.UPDATE_STATUS)
    const job = data.job
    if (!isUpdateJob(job) || generation !== panelGeneration || !viewState.isOpen) return undefined
    renderJobFor(output, job)
    return job
  }

  function pollUpdateStatus(output: JobOutput): void {
    stopPolling()
    const generation = panelGeneration
    statusPollTimer = window.setInterval(() => {
      void refreshUpdateStatus(output, generation)
        .then((job) => {
          if (generation !== panelGeneration || !viewState.isOpen) return
          if (job && !["queued", "running"].includes(job.status)) {
            stopPolling()
            toast(
              job.status === "succeeded" ? "success" : "error",
              "ComfyUI-ControlPanel",
              `${job.label} ${job.status}.`,
            )
          }
        })
        .catch((error: unknown) => {
          if (generation !== panelGeneration || !viewState.isOpen) return
          stopPolling()
          const message = error instanceof Error ? error.message : String(error)
          writeLog(`Status polling failed: ${message}`)
          if (output === "update-check") {
            setViewState({ updateCheckOutput: `Check for Updates failed.\n\n${message}` })
          }
        })
    }, 1500)
  }

  async function startUpdateJob(
    label: string,
    route: string,
    body: JsonObject = {},
    output: JobOutput = "panel",
  ): Promise<void> {
    const generation = panelGeneration
    writeLog(`${label} queued.`)
    debugLog(readBooleanSetting, `${label} request`, { route, body })
    try {
      const data = await api.fetchJson(route, body)
      const job = data.job
      if (!isUpdateJob(job)) throw new Error("Update job response was missing job details.")
      renderJobFor(output, job)
      toast("info", "ComfyUI-ControlPanel", `${label} started.`)
      if (generation === panelGeneration && viewState.isOpen) pollUpdateStatus(output)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`${label} failed to start: ${message}`)
      if (output === "update-check") {
        setViewState({ updateCheckOutput: `Check for Updates failed.\n\n${message}` })
      }
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  function snapshotNamesFromResponse(data: JsonObject): string[] {
    const snapshots = Array.isArray(data.snapshots) ? data.snapshots : []
    return snapshots
      .map((snapshot) => asRecord(snapshot)?.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
  }

  async function listSnapshots(): Promise<string[] | undefined> {
    const generation = ++snapshotRequestGeneration
    writeLog("Snapshot List started.")
    try {
      const data = await api.fetchJson(API_ROUTES.SNAPSHOT_LIST)
      if (generation !== snapshotRequestGeneration || !viewState.isOpen) return undefined
      const names = snapshotNamesFromResponse(data)
      writeLog(`Snapshot List completed.\n${JSON.stringify(data, null, 2)}`)
      if (names.length === 0) {
        toast("warn", "ComfyUI-ControlPanel", "No snapshots were found.")
        return undefined
      }
      return names
    } catch (error) {
      if (generation !== snapshotRequestGeneration || !viewState.isOpen) return undefined
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`Snapshot List failed: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
      return undefined
    }
  }

  async function restoreSnapshot(target: string, onConfirmed: () => void): Promise<void> {
    if (!target) {
      toast("warn", "ComfyUI-ControlPanel", "Select a snapshot to restore.")
      return
    }
    const confirmed = await app.extensionManager.dialog.confirm({
      title: "Restore Snapshot",
      message: `Restoring "${target}" may change installed custom nodes and dependencies. Continue?`,
    })
    if (confirmed) {
      onConfirmed()
      await startUpdateJob("Restore Snapshot", API_ROUTES.SNAPSHOT_RESTORE, { target })
    }
  }

  function nodeRestoreFilename(): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")
    return `comfyui-node-restore-${timestamp}.json`
  }

  function downloadJson(filename: string, value: JsonObject): void {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  async function backupInstalledNodes(): Promise<void> {
    writeLog("Backup Installed Nodes started.")
    try {
      const [installed, inventory] = await Promise.all([
        fetchInstalledPackages(app),
        api.fetchJson(API_ROUTES.NODE_RESTORE_INVENTORY),
      ])
      const manifest = buildNodeRestoreManifest(installed, inventory)
      downloadJson(nodeRestoreFilename(), manifest)
      writeLog("Backup Installed Nodes completed.", manifest)
      const unmanaged = manifest.unmanaged_nodes.length
      toast(
        unmanaged > 0 ? "warn" : "success",
        "ComfyUI-ControlPanel",
        `Backed up ${manifest.registry_nodes.length} registry and ${manifest.git_nodes.length} Git nodes.${unmanaged > 0 ? ` ${unmanaged} unmanaged folders require manual backup.` : ""}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`Backup Installed Nodes failed: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  async function restoreNodesFromFile(file: File): Promise<void> {
    try {
      const manifest = parseNodeRestoreManifest(await file.text())
      const confirmed = await app.extensionManager.dialog.confirm({
        title: "Restore Custom Nodes",
        message: `Install the latest versions of ${manifest.registry_nodes.length} registry and ${manifest.git_nodes.length} Git nodes? Existing Git destination folders will be skipped.`,
      })
      if (confirmed) {
        await startUpdateJob("Restore Custom Nodes", API_ROUTES.NODE_RESTORE_RESTORE, { manifest })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`Restore Custom Nodes failed: ${message}`)
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
      writeLog(formatOperationResult(label, API_ROUTES.RESTART, data) ?? `${label} completed.`)
      toast("info", "ComfyUI-ControlPanel", "Restarting")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`${label} failed: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  async function confirmRestart(): Promise<void> {
    const confirmed = await app.extensionManager.dialog.confirm({
      title: "Restart ComfyUI",
      message: "Restart ComfyUI now?",
    })
    if (confirmed) await restartComfyUI()
  }

  async function rebuildManagerCache(): Promise<void> {
    const confirmed = await app.extensionManager.dialog.confirm({
      title: "Rebuild Manager Cache",
      message: "Rebuilding the Manager cache may take some time. Continue?",
    })
    if (confirmed) await startUpdateJob("Rebuild Manager Cache", API_ROUTES.REBUILD_MANAGER_CACHE)
  }

  async function showEnvironment(): Promise<JsonObject> {
    writeLog("Show Environment started.")
    try {
      const data = await api.fetchJson(API_ROUTES.SHOW_ENVIRONMENT, {})
      writeLog("Show Environment completed.")
      return data
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(`Show Environment failed: ${message}`)
      toast("error", "ComfyUI-ControlPanel", message)
      throw error
    }
  }

  async function showUpdateCheck(): Promise<void> {
    setViewState({ updateCheckOutput: "Preparing update check..." })
    await startUpdateJob("Check for Updates", API_ROUTES.CHECK_UPDATES, {}, "update-check")
  }

  function close(): void {
    panelGeneration += 1
    snapshotRequestGeneration += 1
    stopPolling()
    nodesManager.close()
    setViewState({ isOpen: false })
    host?.remove()
  }

  const actions: ControlPanelActions = {
    getSnapshot: () => viewState,
    subscribe,
    nodesManager,
    close,
    clearLog,
    toast,
    runOperation,
    startUpdateJob: (label, route, body = {}) => startUpdateJob(label, route, body),
    refreshPanelStatus,
    showStatusJson,
    repairMetadata,
    listSnapshots,
    restoreSnapshot,
    backupInstalledNodes,
    restoreNodesFromFile,
    showEnvironment,
    showUpdateCheck,
    restart: confirmRestart,
    rebuildManagerCache,
  }

  function open(): void {
    if (!host) {
      host = document.createElement("div")
      host.dataset.templateTheme = ""
      root = createRoot(host)
      root.render(createElement(ControlPanelPage, { actions }))
    }
    if (!host.isConnected) document.body.append(host)
    setViewState({ isOpen: true })
    void refreshPanelStatus()
  }

  return { ...actions, open }
}
