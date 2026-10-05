import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { createElement } from "react"
import { createRoot, type Root } from "react-dom/client"

import { API_ROUTES } from "../constants.ts"
import { debugLog } from "../debug.ts"
import { I18nProvider } from "../i18n/index.tsx"
import { createTranslator, resolveLocale } from "../i18n/messages.ts"
import type { TranslationKey } from "../i18n/messages.ts"
import { ControlPanelPage } from "../pages/ControlPanelPage.tsx"
import { fetchInstalledPackages } from "../services/cnrMetadata.ts"
import type { FixMetadataSummary } from "../services/cnrMetadataController.ts"
import { createControlPanelApi, isUpdateJob } from "../services/controlPanelApi.ts"
import { restartWithManager } from "../services/managerRestart.ts"
import {
  buildNodeRestoreManifest,
  dependencySyncCommand,
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
  openNodesManager: () => Promise<void>
}

export function createControlPanelController(options: ControlPanelOptions): ControlPanelController {
  const { app, readBooleanSetting } = options
  const readLocale = () => resolveLocale(app.extensionManager.setting?.get?.("Comfy.Locale"))
  const t = createTranslator(readLocale)
  const api = createControlPanelApi(app)
  const nodesManager = createNodesManagerController(app)
  const listeners = new Set<() => void>()
  const dependencySyncNotifiedJobs = new Set<string>()
  let viewState: ControlPanelViewState = {
    isOpen: false,
    log: `${t("panel.ready")}\n`,
    managerCacheControlsEnabled: false,
    managerCacheStatus: "panel.checkingRepositorySetting",
    updateCheckOutput: t("operation.updateCheckPreparing"),
  }
  let host: HTMLDivElement | undefined
  let root: Root | undefined
  let statusPollTimer: number | undefined
  let panelGeneration = 0
  let snapshotRequestGeneration = 0
  let restartPending = false

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

    const lines = [t("operation.installGitCompleted")]
    if (destination) {
      const pathParts = destination.split(/[\\/]/).filter(Boolean)
      const folderName = pathParts[pathParts.length - 1] ?? destination
      lines.push(t("operation.installed", { name: folderName }))
      lines.push(t("operation.path", { path: destination }))
    }
    if (stdout) lines.push("", stdout)
    if (stderr) lines.push("", stderr)
    return lines.join("\n")
  }

  function formatOperationResult(
    label: TranslationKey,
    route: string,
    data: JsonObject,
  ): string | undefined {
    if (route === API_ROUTES.INSTALL_GIT_URL) return formatGitInstallResult(data)
    return `${t("operation.completedLog", { operation: t(label) })}\n${JSON.stringify(data, null, 2)}`
  }

  function writeLog(message: string, payload?: unknown): void {
    const timestamp = new Date().toLocaleTimeString(readLocale())
    const body = payload === undefined ? "" : `\n${JSON.stringify(payload, null, 2)}`
    setViewState({ log: `${viewState.log}[${timestamp}] ${message}${body}\n\n` })
  }

  function clearLog(): void {
    setViewState({ log: `${t("panel.ready")}\n` })
  }

  function jobStatusLabel(status: UpdateJob["status"]): string {
    return t(`operation.status.${status}` as TranslationKey)
  }

  function renderJob(job: UpdateJob, label: TranslationKey): void {
    const operation = t(label)
    const logs =
      job.logs.length > 0
        ? job.logs.join("\n")
        : t("operation.status", { operation, status: jobStatusLabel(job.status) })
    const error = job.error ? `\n\n${t("panel.errorLabel")}:\n${job.error}` : ""
    const command = job.status === "succeeded" ? dependencySyncCommand(job.result) : undefined
    const syncNotice = command ? t("nodeRestore.dependencySyncRequired", { command }) : undefined
    const requiredAction = syncNotice ? `\n\n${t("panel.actionRequiredLabel")}:\n${syncNotice}` : ""
    setViewState({
      log: `${operation} (${jobStatusLabel(job.status)})\n\n${logs}${error}${requiredAction}\n`,
      restartNotice:
        job.restart_required && job.status === "succeeded"
          ? command
            ? "nodeRestore.dependencySyncRequired"
            : "panel.restartToApply"
          : undefined,
      restartNoticeValues: command ? { command } : undefined,
    })
    if (syncNotice && !dependencySyncNotifiedJobs.has(job.id)) {
      dependencySyncNotifiedJobs.add(job.id)
      toast("warn", t("toast.dependencySyncTitle"), syncNotice)
    }
  }

  function renderUpdateCheckJob(job: UpdateJob, label: TranslationKey): void {
    const operation = t(label)
    const logs =
      job.logs.length > 0
        ? job.logs.join("\n")
        : t("operation.status", { operation, status: jobStatusLabel(job.status) })
    const error = job.error ? `\n\n${t("panel.errorLabel")}:\n${job.error}` : ""
    setViewState({
      updateCheckOutput: `${operation} (${jobStatusLabel(job.status)})\n\n${logs}${error}`,
    })
  }

  function renderJobFor(output: JobOutput, job: UpdateJob, label: TranslationKey): void {
    if (output === "update-check") renderUpdateCheckJob(job, label)
    else renderJob(job, label)
  }

  async function runOperation(
    label: TranslationKey,
    route: string,
    body?: JsonObject,
  ): Promise<JsonObject | undefined> {
    const operation = t(label)
    writeLog(t("operation.started", { operation }))
    debugLog(readBooleanSetting, `${operation} request`, { route, body })
    try {
      const data = await api.fetchJson(route, body)
      writeLog(
        formatOperationResult(label, route, data) ?? t("operation.completedLog", { operation }),
      )
      toast("success", "ComfyUI-ControlPanel", t("operation.completedLog", { operation }))
      return data
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(t("operation.failedLog", { operation, error: message }))
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
          ? "panel.managerCacheEnabled"
          : "panel.managerCacheEnableSetting",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setViewState({
        managerCacheControlsEnabled: false,
        managerCacheStatus: "panel.statusCheckFailed",
      })
      writeLog(t("operation.statusFailed", { error: message }))
    }
  }

  async function showStatusJson(): Promise<void> {
    writeLog(t("operation.statusJsonStarted"))
    try {
      const data = await fetchStatus()
      writeLog(t("operation.statusJsonCompleted"), data)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(t("operation.statusJsonFailed", { error: message }))
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  async function repairMetadata(): Promise<void> {
    writeLog(t("operation.metadataStarted"))
    const summary = await options.fixCnrId()
    if (!summary) {
      writeLog(t("operation.metadataStopped"))
      return
    }
    writeLog(t("operation.metadataCompleted"), {
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
    label: TranslationKey,
    generation: number,
  ): Promise<UpdateJob | undefined> {
    const data = await api.fetchJson(API_ROUTES.UPDATE_STATUS)
    const job = data.job
    if (!isUpdateJob(job) || generation !== panelGeneration || !viewState.isOpen) return undefined
    renderJobFor(output, job, label)
    return job
  }

  function pollUpdateStatus(output: JobOutput, label: TranslationKey): void {
    stopPolling()
    const generation = panelGeneration
    statusPollTimer = window.setInterval(() => {
      void refreshUpdateStatus(output, label, generation)
        .then((job) => {
          if (generation !== panelGeneration || !viewState.isOpen) return
          if (job && !["queued", "running"].includes(job.status)) {
            stopPolling()
            toast(
              job.status === "succeeded" ? "success" : "error",
              "ComfyUI-ControlPanel",
              t("operation.status", {
                operation: t(label),
                status: jobStatusLabel(job.status),
              }),
            )
          }
        })
        .catch((error: unknown) => {
          if (generation !== panelGeneration || !viewState.isOpen) return
          stopPolling()
          const message = error instanceof Error ? error.message : String(error)
          writeLog(t("operation.statusPollingFailed", { error: message }))
          if (output === "update-check") {
            setViewState({
              updateCheckOutput: t("operation.updateCheckFailed", { error: message }),
            })
          }
        })
    }, 1500)
  }

  async function startUpdateJob(
    label: TranslationKey,
    route: string,
    body: JsonObject = {},
    output: JobOutput = "panel",
  ): Promise<void> {
    const generation = panelGeneration
    const operation = t(label)
    writeLog(t("operation.queued", { operation }))
    debugLog(readBooleanSetting, `${operation} request`, { route, body })
    try {
      const data = await api.fetchJson(route, body)
      const job = data.job
      if (!isUpdateJob(job)) throw new Error(t("error.updateJobMissing"))
      renderJobFor(output, job, label)
      toast("info", "ComfyUI-ControlPanel", t("operation.started", { operation }))
      if (generation === panelGeneration && viewState.isOpen) pollUpdateStatus(output, label)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(t("operation.failedToStart", { operation, error: message }))
      if (output === "update-check") {
        setViewState({ updateCheckOutput: t("operation.updateCheckFailed", { error: message }) })
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
    writeLog(t("operation.snapshotListStarted"))
    try {
      const data = await api.fetchJson(API_ROUTES.SNAPSHOT_LIST)
      if (generation !== snapshotRequestGeneration || !viewState.isOpen) return undefined
      const names = snapshotNamesFromResponse(data)
      writeLog(`${t("operation.snapshotListCompleted")}\n${JSON.stringify(data, null, 2)}`)
      if (names.length === 0) {
        toast("warn", "ComfyUI-ControlPanel", t("operation.noSnapshots"))
        return undefined
      }
      return names
    } catch (error) {
      if (generation !== snapshotRequestGeneration || !viewState.isOpen) return undefined
      const message = error instanceof Error ? error.message : String(error)
      writeLog(t("operation.snapshotListFailed", { error: message }))
      toast("error", "ComfyUI-ControlPanel", message)
      return undefined
    }
  }

  async function restoreSnapshot(target: string, onConfirmed: () => void): Promise<void> {
    if (!target) {
      toast("warn", "ComfyUI-ControlPanel", t("operation.selectSnapshot"))
      return
    }
    const confirmed = await app.extensionManager.dialog.confirm({
      title: t("operation.restoreSnapshotConfirmTitle"),
      message: t("operation.restoreSnapshotConfirm", { target }),
    })
    if (confirmed) {
      onConfirmed()
      await startUpdateJob("operation.restoreSnapshotLabel", API_ROUTES.SNAPSHOT_RESTORE, {
        target,
      })
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
    writeLog(t("operation.backupNodesStarted"))
    try {
      const [installed, inventory] = await Promise.all([
        fetchInstalledPackages(app),
        api.fetchJson(API_ROUTES.NODE_RESTORE_INVENTORY),
      ])
      const manifest = buildNodeRestoreManifest(installed, inventory)
      downloadJson(nodeRestoreFilename(), manifest)
      writeLog(t("operation.backupNodesCompleted"), manifest)
      const unmanaged = manifest.unmanaged_nodes.length
      const summary = t("operation.backupSummary", {
        registryCount: manifest.registry_nodes.length,
        gitCount: manifest.git_nodes.length,
      })
      toast(
        unmanaged > 0 ? "warn" : "success",
        "ComfyUI-ControlPanel",
        `${summary}${unmanaged > 0 ? ` ${t("operation.unmanagedBackupWarning", { count: unmanaged })}` : ""}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(t("operation.backupNodesFailed", { error: message }))
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  async function restoreNodesFromFile(file: File): Promise<void> {
    try {
      const manifest = parseNodeRestoreManifest(await file.text(), t)
      const confirmed = await app.extensionManager.dialog.confirm({
        title: t("operation.restoreNodesConfirmTitle"),
        message: t("operation.restoreNodesConfirm", {
          registryCount: manifest.registry_nodes.length,
          gitCount: manifest.git_nodes.length,
        }),
      })
      if (confirmed) {
        await startUpdateJob("operation.restoreNodesLabel", API_ROUTES.NODE_RESTORE_RESTORE, {
          manifest,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(t("operation.restoreNodesFailed", { error: message }))
      toast("error", "ComfyUI-ControlPanel", message)
    }
  }

  async function restartComfyUI(): Promise<void> {
    if (restartPending) return
    restartPending = true
    setViewState({ restartPending: true })
    writeLog(t("operation.restartStarted"))
    toast("info", "ComfyUI-ControlPanel", t("operation.restarting"))
    try {
      await restartWithManager(app, t)
      const message = t("operation.completedLog", { operation: t("panel.action.restart") })
      writeLog(message)
      toast("success", "ComfyUI-ControlPanel", message)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(t("operation.restartFailed", { error: message }))
      toast("error", "ComfyUI-ControlPanel", message)
    } finally {
      restartPending = false
      setViewState({ restartPending: false })
    }
  }

  async function confirmRestart(): Promise<void> {
    if (restartPending) return
    const confirmed = await app.extensionManager.dialog.confirm({
      title: t("operation.restartConfirmTitle"),
      message: t("operation.restartConfirm"),
    })
    if (confirmed) await restartComfyUI()
  }

  async function rebuildManagerCache(): Promise<void> {
    const confirmed = await app.extensionManager.dialog.confirm({
      title: t("operation.rebuildCacheConfirmTitle"),
      message: t("operation.rebuildCacheConfirm"),
    })
    if (confirmed)
      await startUpdateJob("panel.action.rebuildManagerCache", API_ROUTES.REBUILD_MANAGER_CACHE)
  }

  async function showEnvironment(): Promise<JsonObject> {
    writeLog(t("operation.environmentStarted"))
    try {
      const data = await api.fetchJson(API_ROUTES.SHOW_ENVIRONMENT, {})
      writeLog(t("operation.environmentCompleted"))
      return data
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog(t("operation.environmentFailed", { error: message }))
      toast("error", "ComfyUI-ControlPanel", message)
      throw error
    }
  }

  async function showUpdateCheck(): Promise<void> {
    setViewState({ updateCheckOutput: t("operation.updateCheckPreparing") })
    await startUpdateJob("updateCheck.title", API_ROUTES.CHECK_UPDATES, {}, "update-check")
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

  function ensureHost(): void {
    if (!host) {
      host = document.createElement("div")
      host.dataset.templateTheme = ""
      root = createRoot(host)
      root.render(
        createElement(
          I18nProvider,
          { settings: app.ui?.settings ?? new EventTarget(), readLocale },
          createElement(ControlPanelPage, { actions }),
        ),
      )
    }
    if (!host.isConnected) document.body.append(host)
  }

  function open(): void {
    ensureHost()
    setViewState({ isOpen: true })
    void refreshPanelStatus()
  }

  async function openNodesManager(): Promise<void> {
    ensureHost()
    await nodesManager.open()
  }

  return { ...actions, open, openNodesManager }
}
