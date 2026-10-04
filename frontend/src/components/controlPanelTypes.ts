import type { TranslationKey, TranslationValues } from "../i18n/messages.ts"
import type { NodesManagerController } from "../services/nodesManagerController.ts"
import type { JsonObject, ToastSeverity } from "../types.ts"

export type ControlPanelViewState = {
  isOpen: boolean
  log: string
  managerCacheControlsEnabled: boolean
  managerCacheStatus: TranslationKey
  restartNotice?: TranslationKey
  restartNoticeValues?: TranslationValues
  updateCheckOutput: string
}

export type ControlPanelViewStore = {
  getSnapshot: () => ControlPanelViewState
  subscribe: (listener: () => void) => () => void
}

export type ControlPanelActions = ControlPanelViewStore & {
  nodesManager: NodesManagerController
  close: () => void
  clearLog: () => void
  toast: (severity: ToastSeverity, summary: string, detail: string) => void
  runOperation: (
    label: TranslationKey,
    route: string,
    body?: JsonObject,
  ) => Promise<JsonObject | undefined>
  startUpdateJob: (label: TranslationKey, route: string, body?: JsonObject) => Promise<void>
  refreshPanelStatus: () => Promise<void>
  showStatusJson: () => Promise<void>
  repairMetadata: () => Promise<void>
  listSnapshots: () => Promise<string[] | undefined>
  restoreSnapshot: (target: string, onConfirmed: () => void) => Promise<void>
  backupInstalledNodes: () => Promise<void>
  restoreNodesFromFile: (file: File) => Promise<void>
  showEnvironment: () => Promise<JsonObject>
  showUpdateCheck: () => Promise<void>
  restart: () => Promise<void>
  rebuildManagerCache: () => Promise<void>
}
