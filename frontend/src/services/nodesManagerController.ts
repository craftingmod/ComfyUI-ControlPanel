import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import { createTranslator, type TranslationKey, type TranslationValues } from "../i18n/messages.ts"
import {
  buildManagerQueuePayload,
  createNodesManagerService,
  findHistoryItem,
  findInstalledPack,
  ManagerRequestError,
  normalizeManagedPacks,
  type InstalledPack,
  type ManagerOperation,
  type ManagerTaskHistory,
  type ManagedPack,
  type RegistryNode,
  type RegistryVersion,
  sameManagedPackTarget,
} from "./nodesManager.ts"

export type NodesManagerOperationState = {
  packKey: string
  pack: ManagedPack
  taskId: string
  clientId: string
  operation: ManagerOperation
  status: "starting" | "pending" | "unknown" | "succeeded" | "failed" | "skipped"
  message?: string
  messageKey?: TranslationKey
  messageValues?: TranslationValues
  selectedVersion?: string
  managerStatus?: "success" | "error" | "skip"
  accepted?: boolean
  queueStartFailed?: boolean
  restartRequired?: boolean
}

export type NodesManagerSnapshot = {
  isOpen: boolean
  catalogStatus: "idle" | "loading" | "ready" | "error"
  catalogError?: string
  catalogErrorKey?: TranslationKey
  catalogErrorValues?: TranslationValues
  catalogSource?: string
  catalogWarning?: string
  installedStatus: "idle" | "loading" | "ready" | "error"
  installedError?: string
  installedErrorKey?: TranslationKey
  installedErrorValues?: TranslationValues
  installed: InstalledPack[]
  packs: ManagedPack[]
  operations: Record<string, NodesManagerOperationState>
  versions: Record<
    string,
    {
      loading: boolean
      error?: string
      errorKey?: TranslationKey
      errorValues?: TranslationValues
      values?: RegistryVersion[]
    }
  >
  checking: boolean
}

type ConfirmOptions = { title: string; message: string }

export type NodesManagerController = {
  getSnapshot: () => NodesManagerSnapshot
  subscribe: (listener: () => void) => () => void
  open: () => Promise<void>
  close: () => void
  refresh: () => Promise<void>
  loadVersions: (pack: ManagedPack) => Promise<void>
  submit: (
    pack: ManagedPack,
    operation: ManagerOperation,
    selectedVersion?: string,
  ) => Promise<boolean>
  retryQueueStart: (packKey: string) => Promise<boolean>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorDetails(error: unknown): {
  message?: string
  key?: TranslationKey
  values?: TranslationValues
} {
  if (error instanceof ManagerRequestError && error.translationKey) {
    return { key: error.translationKey, values: error.translationValues }
  }
  return { message: errorMessage(error) }
}

function newTaskId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function clientIdFor(app: ComfyApp): string {
  const api = app.api as typeof app.api & { clientId?: string; initialClientId?: string }
  return api.clientId ?? api.initialClientId ?? "unknown"
}

function isActive(operation: NodesManagerOperationState | undefined): boolean {
  return Boolean(operation && ["starting", "pending", "unknown"].includes(operation.status))
}

function shouldPoll(operation: NodesManagerOperationState): boolean {
  return (
    (operation.status === "pending" || operation.status === "unknown") &&
    operation.managerStatus === undefined
  )
}

export function findOperationForPack(
  operations: Record<string, NodesManagerOperationState>,
  pack: ManagedPack,
): NodesManagerOperationState | undefined {
  return (
    operations[pack.key] ??
    Object.values(operations).find((operation) => sameManagedPackTarget(operation.pack, pack))
  )
}

function effectIsPresent(
  operation: NodesManagerOperationState,
  pack: ManagedPack | undefined,
  installed: InstalledPack[],
): boolean {
  if (!pack) return false
  const found = findInstalledPack(installed, pack)
  if (operation.operation === "uninstall") return found === undefined
  if (!found) return false
  switch (operation.operation) {
    case "install":
    case "switch":
      return found.version === operation.selectedVersion
    case "enable":
      return found.enabled === true
    case "disable":
      return found.enabled === false
    case "update":
      return true
  }
}

function terminalStatus(item: ManagerTaskHistory): "success" | "error" | "skip" | undefined {
  if (item.status?.completed !== true) return undefined
  const status = item.status.status_str?.toLocaleLowerCase()
  return status === "success" || status === "error" || status === "skip" ? status : undefined
}

export function createNodesManagerController(app: ComfyApp): NodesManagerController {
  const service = createNodesManagerService(app)
  const t = createTranslator(() => app.extensionManager.setting?.get?.("Comfy.Locale"))
  const listeners = new Set<() => void>()
  let snapshot: NodesManagerSnapshot = {
    isOpen: false,
    catalogStatus: "idle",
    installedStatus: "idle",
    installed: [],
    packs: [],
    operations: {},
    versions: {},
    checking: false,
  }
  let catalogNodes: RegistryNode[] = []
  let readGeneration = 0
  let installedReadGeneration = 0
  let dialogGeneration = 0
  const versionGenerations = new Map<string, number>()
  let pollTimer: number | undefined
  let pollRunning = false

  function publish(next: NodesManagerSnapshot): void {
    snapshot = next
    for (const listener of listeners) listener()
    syncPolling()
  }

  function update(patch: Partial<NodesManagerSnapshot>): void {
    publish({ ...snapshot, ...patch })
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function replaceOperation(operation: NodesManagerOperationState): void {
    update({ operations: { ...snapshot.operations, [operation.packKey]: operation } })
  }

  function withMessageKey(
    operation: NodesManagerOperationState,
    messageKey: TranslationKey,
    messageValues?: TranslationValues,
  ): NodesManagerOperationState {
    return { ...operation, message: undefined, messageKey, messageValues }
  }

  function withRawMessage(
    operation: NodesManagerOperationState,
    message: string,
  ): NodesManagerOperationState {
    return { ...operation, message, messageKey: undefined, messageValues: undefined }
  }

  function showToast(
    severity: "success" | "warn" | "error",
    summary: string,
    detail: string,
  ): void {
    app.extensionManager.toast.add({ severity, summary, detail, life: 5000 })
  }

  async function refresh(): Promise<void> {
    const generation = ++readGeneration
    const installedGeneration = ++installedReadGeneration
    update({
      catalogStatus: "loading",
      catalogError: undefined,
      catalogErrorKey: undefined,
      catalogErrorValues: undefined,
      installedStatus: "loading",
      installedError: undefined,
      installedErrorKey: undefined,
      installedErrorValues: undefined,
    })
    const [catalogResult, installedResult] = await Promise.allSettled([
      service.loadCatalog(),
      service.loadInstalled(),
    ])
    if (generation !== readGeneration || !snapshot.isOpen) return

    let catalogStatus = snapshot.catalogStatus
    let catalogError: string | undefined
    let catalogErrorKey: TranslationKey | undefined
    let catalogErrorValues: TranslationValues | undefined
    let catalogSource = snapshot.catalogSource
    let catalogWarning = snapshot.catalogWarning
    if (catalogResult.status === "fulfilled") {
      catalogNodes = catalogResult.value.nodes
      catalogStatus = "ready"
      catalogErrorKey = undefined
      catalogErrorValues = undefined
      catalogSource = catalogResult.value.source
      catalogWarning = catalogResult.value.warning
    } else {
      catalogStatus = "error"
      const error = errorDetails(catalogResult.reason)
      catalogError = error.message
      catalogErrorKey = error.key
      catalogErrorValues = error.values
    }

    let installedStatus = snapshot.installedStatus
    let installedError = snapshot.installedError
    let installedErrorKey = snapshot.installedErrorKey
    let installedErrorValues = snapshot.installedErrorValues
    let installed = snapshot.installed
    if (installedGeneration === installedReadGeneration) {
      if (installedResult.status === "fulfilled") {
        installed = installedResult.value
        installedStatus = "ready"
        installedError = undefined
        installedErrorKey = undefined
        installedErrorValues = undefined
      } else {
        installedStatus = "error"
        const error = errorDetails(installedResult.reason)
        installedError = error.message
        installedErrorKey = error.key
        installedErrorValues = error.values
      }
    }

    const packs = normalizeManagedPacks({ nodes: catalogNodes }, installed)
    publish({
      ...snapshot,
      catalogStatus,
      catalogError,
      catalogErrorKey,
      catalogErrorValues,
      catalogSource,
      catalogWarning,
      installedStatus,
      installedError,
      installedErrorKey,
      installedErrorValues,
      installed,
      packs,
    })
    if (installedResult.status === "fulfilled" && installedGeneration === installedReadGeneration) {
      await reconcileManagerSuccesses(installed)
    }
    await pollPending()
  }

  function packFor(operation: NodesManagerOperationState): ManagedPack | undefined {
    return snapshot.packs.find((pack) => pack.key === operation.packKey) ?? operation.pack
  }

  async function reconcileOperation(
    operation: NodesManagerOperationState,
    installed: InstalledPack[],
  ): Promise<void> {
    if (operation.managerStatus !== "success") return
    const satisfied = effectIsPresent(operation, packFor(operation), installed)
    if (!satisfied) {
      replaceOperation({
        ...withMessageKey(operation, "nodes.operationUnconfirmed"),
        status: "unknown",
      })
      return
    }
    replaceOperation({
      ...withMessageKey(operation, "nodes.operationConfirmed"),
      status: "succeeded",
      restartRequired: true,
    })
    showToast("warn", t("toast.restartRequired"), t("toast.restartForNodes"))
  }

  async function reconcileManagerSuccesses(installed: InstalledPack[]): Promise<void> {
    const pending = Object.values(snapshot.operations).filter(
      (operation) => operation.managerStatus === "success" && operation.status === "unknown",
    )
    for (const operation of pending) await reconcileOperation(operation, installed)
  }

  async function pollOne(operation: NodesManagerOperationState, generation: number): Promise<void> {
    const isCurrent = () =>
      snapshot.isOpen &&
      generation === dialogGeneration &&
      snapshot.operations[operation.packKey]?.taskId === operation.taskId
    try {
      const response = await service.getTaskHistory(operation.taskId, operation.clientId)
      if (!isCurrent()) return
      const item = findHistoryItem(response, operation.taskId, operation.clientId)
      if (!item) return
      const status = terminalStatus(item)
      if (!status) return
      if (status !== "success") {
        const installedGeneration = ++installedReadGeneration
        const installed = await service.loadInstalled().catch(() => undefined)
        if (!isCurrent()) return
        if (installed && installedGeneration === installedReadGeneration) {
          update({
            installed,
            installedStatus: "ready",
            installedError: undefined,
            installedErrorKey: undefined,
            installedErrorValues: undefined,
          })
          update({ packs: normalizeManagedPacks({ nodes: catalogNodes }, installed) })
        } else if (installedGeneration === installedReadGeneration) {
          update({
            installedStatus: "error",
            installedError: undefined,
            installedErrorKey: "nodes.installedRefreshFailed",
            installedErrorValues: undefined,
          })
        }
        const historyMessage = item.status?.messages?.filter(Boolean).join("\n")
        replaceOperation({
          ...(historyMessage
            ? withRawMessage(operation, historyMessage)
            : withMessageKey(
                operation,
                status === "skip" ? "nodes.taskSkipped" : "nodes.managerError",
              )),
          status: status === "skip" ? "skipped" : "failed",
          managerStatus: status,
        })
        showToast(
          status === "skip" ? "warn" : "error",
          status === "skip"
            ? t("toast.nodesManagerTaskSkipped")
            : t("toast.nodesManagerTaskFailed"),
          status === "skip" ? t("toast.noChangeConfirmed") : t("toast.managerReportedError"),
        )
        return
      }

      const terminal = { ...operation, managerStatus: "success" as const }
      replaceOperation({
        ...withMessageKey(terminal, "nodes.taskCompletedRefreshing"),
        status: "unknown",
      })
      try {
        const installedGeneration = ++installedReadGeneration
        const installed = await service.loadInstalled()
        if (!isCurrent()) return
        if (installedGeneration !== installedReadGeneration) return
        update({
          installed,
          installedStatus: "ready",
          installedError: undefined,
          installedErrorKey: undefined,
          installedErrorValues: undefined,
        })
        const packs = normalizeManagedPacks({ nodes: catalogNodes }, installed)
        update({ packs })
        await reconcileOperation(terminal, installed)
      } catch (error) {
        if (!isCurrent()) return
        replaceOperation({
          ...withMessageKey(terminal, "nodes.taskRefreshError", { error: errorMessage(error) }),
          status: "unknown",
        })
        const details = errorDetails(error)
        update({
          installedStatus: "error",
          installedError: details.message,
          installedErrorKey: details.key,
          installedErrorValues: details.values,
        })
      }
    } catch (error) {
      if (!isCurrent()) return
      replaceOperation({
        ...withMessageKey(operation, "nodes.taskHistoryError", {
          error: errorMessage(error),
        }),
        status: "unknown",
      })
    }
  }

  async function pollPending(): Promise<void> {
    if (pollRunning || !snapshot.isOpen) return
    const pending = Object.values(snapshot.operations).filter(shouldPoll)
    if (pending.length === 0) return
    pollRunning = true
    const generation = dialogGeneration
    update({ checking: true })
    try {
      for (const operation of pending) {
        if (!snapshot.isOpen) break
        await pollOne(operation, generation)
      }
    } finally {
      pollRunning = false
      update({ checking: false })
      if (snapshot.isOpen && generation !== dialogGeneration) void pollPending()
    }
  }

  function syncPolling(): void {
    const hasPending = Object.values(snapshot.operations).some(shouldPoll)
    if (!snapshot.isOpen || !hasPending) {
      if (pollTimer !== undefined) window.clearInterval(pollTimer)
      pollTimer = undefined
      return
    }
    if (pollTimer === undefined) {
      pollTimer = window.setInterval(() => void pollPending(), 2500)
    }
  }

  async function open(): Promise<void> {
    if (snapshot.isOpen) return
    dialogGeneration += 1
    update({ isOpen: true })
    await refresh()
  }

  function close(): void {
    dialogGeneration += 1
    readGeneration += 1
    installedReadGeneration += 1
    const versions = Object.fromEntries(
      Object.entries(snapshot.versions).map(([key, value]) => [
        key,
        value.loading ? { ...value, loading: false } : value,
      ]),
    )
    update({ isOpen: false, checking: false, versions })
  }

  async function loadVersions(pack: ManagedPack): Promise<void> {
    if (!pack.id || snapshot.versions[pack.key]?.loading) return
    const generation = dialogGeneration
    const versionGeneration = (versionGenerations.get(pack.key) ?? 0) + 1
    versionGenerations.set(pack.key, versionGeneration)
    update({
      versions: {
        ...snapshot.versions,
        [pack.key]: {
          ...snapshot.versions[pack.key],
          loading: true,
          error: undefined,
          errorKey: undefined,
          errorValues: undefined,
        },
      },
    })
    try {
      const values = await service.loadVersions(pack.id)
      if (
        !snapshot.isOpen ||
        generation !== dialogGeneration ||
        versionGenerations.get(pack.key) !== versionGeneration
      )
        return
      update({ versions: { ...snapshot.versions, [pack.key]: { loading: false, values } } })
    } catch (error) {
      if (
        !snapshot.isOpen ||
        generation !== dialogGeneration ||
        versionGenerations.get(pack.key) !== versionGeneration
      )
        return
      const details = errorDetails(error)
      update({
        versions: {
          ...snapshot.versions,
          [pack.key]: {
            loading: false,
            error: details.message,
            errorKey: details.key,
            errorValues: details.values,
          },
        },
      })
    }
  }

  async function confirm(
    operation: ManagerOperation,
    pack: ManagedPack,
    selectedVersion?: string,
  ): Promise<boolean> {
    const options: ConfirmOptions | undefined =
      operation === "uninstall"
        ? {
            title: t("nodes.confirm.uninstallTitle"),
            message: t("nodes.confirm.uninstall", { name: pack.name }),
          }
        : operation === "switch"
          ? {
              title: t("nodes.confirm.switchTitle"),
              message: t("nodes.confirm.switch", {
                name: pack.name,
                version: selectedVersion ?? t("nodes.unknown"),
              }),
            }
          : undefined
    return options ? (await app.extensionManager.dialog.confirm(options)) === true : true
  }

  async function submit(
    pack: ManagedPack,
    operation: ManagerOperation,
    selectedVersion?: string,
  ): Promise<boolean> {
    if (snapshot.installedStatus !== "ready") {
      showToast("warn", t("nodes.managerUnavailableTitle"), t("nodes.managerUnavailableRefresh"))
      return false
    }
    if (isActive(findOperationForPack(snapshot.operations, pack))) return false
    const taskId = newTaskId()
    const clientId = clientIdFor(app)
    const session = dialogGeneration
    const previous = snapshot.operations[pack.key]
    const state: NodesManagerOperationState = {
      packKey: pack.key,
      pack,
      taskId,
      clientId,
      operation,
      status: "starting",
      selectedVersion,
      messageKey:
        operation === "uninstall" || operation === "switch"
          ? "nodes.waitingConfirmation"
          : "nodes.preparingTask",
    }
    replaceOperation(state)

    let confirmed: boolean
    try {
      confirmed = await confirm(operation, pack, selectedVersion)
    } catch (error) {
      confirmed = false
      showToast("error", t("toast.nodesManager"), errorMessage(error))
    }
    const restoreReservation = () => {
      if (snapshot.operations[pack.key]?.taskId !== taskId) return
      const operations = { ...snapshot.operations }
      if (previous) operations[pack.key] = previous
      else delete operations[pack.key]
      update({ operations })
    }
    if (!confirmed || !snapshot.isOpen || session !== dialogGeneration) {
      restoreReservation()
      return false
    }
    if (snapshot.installedStatus !== "ready") {
      restoreReservation()
      showToast("warn", t("nodes.managerUnavailableTitle"), t("nodes.managerUnavailableRefresh"))
      return false
    }

    let payload
    try {
      payload = buildManagerQueuePayload(pack, operation, clientId, taskId, selectedVersion)
    } catch {
      replaceOperation({
        ...withMessageKey(state, "toast.selectVersion"),
        status: "failed",
      })
      return false
    }

    replaceOperation(withMessageKey(state, "nodes.submittingTask"))
    try {
      await service.enqueue(payload)
    } catch (error) {
      const definitive =
        typeof (error as { status?: unknown })?.status === "number" &&
        (error as { status: number }).status >= 400 &&
        (error as { status: number }).status < 500
      replaceOperation(
        definitive
          ? {
              ...withRawMessage(state, errorMessage(error)),
              status: "failed",
            }
          : {
              ...withMessageKey(state, "nodes.acceptanceUncertain", {
                error: errorMessage(error),
              }),
              status: "unknown",
            },
      )
      if (!definitive) void pollPending()
      return false
    }

    try {
      await service.startQueue()
      if (snapshot.operations[pack.key]?.taskId !== taskId) return false
      replaceOperation({
        ...withMessageKey(state, "nodes.acceptedWaiting"),
        status: "pending",
        accepted: true,
      })
      await pollPending()
      return true
    } catch (error) {
      replaceOperation({
        ...withMessageKey(state, "nodes.couldNotStartQueue", { error: errorMessage(error) }),
        status: "unknown",
        accepted: true,
        queueStartFailed: true,
      })
      await pollPending()
      return false
    }
  }

  async function retryQueueStart(packKey: string): Promise<boolean> {
    const operation = snapshot.operations[packKey]
    if (
      !operation?.accepted ||
      !operation.queueStartFailed ||
      operation.managerStatus !== undefined ||
      operation.status !== "unknown"
    ) {
      return false
    }
    replaceOperation({
      ...withMessageKey(operation, "nodes.startingAcceptedTask"),
      status: "starting",
    })
    try {
      await service.startQueue()
      if (snapshot.operations[packKey]?.taskId !== operation.taskId) return false
      replaceOperation({
        ...withMessageKey(operation, "nodes.queueStartedWaiting"),
        status: "pending",
        accepted: true,
        queueStartFailed: false,
      })
      await pollPending()
      return true
    } catch (error) {
      if (snapshot.operations[packKey]?.taskId !== operation.taskId) return false
      replaceOperation({
        ...withMessageKey(operation, "nodes.queueStillAccepted", { error: errorMessage(error) }),
        status: "unknown",
        accepted: true,
        queueStartFailed: true,
      })
      return false
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe,
    open,
    close,
    refresh,
    loadVersions,
    submit,
    retryQueueStart,
  }
}
