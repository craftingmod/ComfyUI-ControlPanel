import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { ControlPanelActionGroup } from "../components/controlPanelActionGroup.tsx"
import { ControlPanelDialog } from "../components/controlPanelDialog.tsx"
import type { ControlPanelActions } from "../components/controlPanelTypes.ts"
import { EnvironmentModal } from "../components/environmentModal.tsx"
import { GitInstallModal } from "../components/gitInstallModal.tsx"
import { SnapshotRestoreModal } from "../components/snapshotRestoreModal.tsx"
import { Button } from "../components/ui/button.tsx"
import { UpdateCheckModal } from "../components/updateCheckModal.tsx"
import { API_ROUTES } from "../constants.ts"
import { useI18n } from "../i18n/index.tsx"
import type { ToastSeverity } from "../types.ts"
import { NodesManagerPage } from "./NodesManagerPage.tsx"

import styles from "../components/controlPanel.module.css"

type ControlPanelPageProps = {
  actions: ControlPanelActions
}

export function ControlPanelPage({ actions }: ControlPanelPageProps) {
  const { t } = useI18n()
  const view = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot)
  const nodesManagerView = useSyncExternalStore(
    actions.nodesManager.subscribe,
    actions.nodesManager.getSnapshot,
    actions.nodesManager.getSnapshot,
  )
  const [gitInstallOpen, setGitInstallOpen] = useState(false)
  const [gitUrl, setGitUrl] = useState("")
  const [gitFolderName, setGitFolderName] = useState("")
  const [snapshotRestoreOpen, setSnapshotRestoreOpen] = useState(false)
  const [snapshotNames, setSnapshotNames] = useState<string[]>([])
  const [selectedSnapshot, setSelectedSnapshot] = useState("")
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [environmentData, setEnvironmentData] = useState<Record<string, unknown>>()
  const [environmentError, setEnvironmentError] = useState<string>()
  const [updateCheckOpen, setUpdateCheckOpen] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const snapshotRequestRef = useRef(0)
  const environmentRequestRef = useRef(0)
  const panelOpenRef = useRef(view.isOpen)
  const environmentOpenRef = useRef(environmentOpen)

  useLayoutEffect(() => {
    panelOpenRef.current = view.isOpen
    if (view.isOpen) return
    environmentOpenRef.current = false
    snapshotRequestRef.current += 1
    environmentRequestRef.current += 1
  }, [view.isOpen])

  const closePanel = useCallback(() => {
    panelOpenRef.current = false
    environmentOpenRef.current = false
    snapshotRequestRef.current += 1
    environmentRequestRef.current += 1
    setGitInstallOpen(false)
    setSnapshotRestoreOpen(false)
    setEnvironmentOpen(false)
    setUpdateCheckOpen(false)
    actions.close()
  }, [actions])

  useEffect(() => {
    const log = logRef.current
    if (!log) return
    const frame = window.requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [view.log, view.isOpen])

  async function openSnapshotRestore(): Promise<void> {
    const requestId = ++snapshotRequestRef.current
    const names = await actions.listSnapshots()
    if (!names || requestId !== snapshotRequestRef.current || !panelOpenRef.current) return
    setSnapshotNames(names)
    setSelectedSnapshot((current) => (names.includes(current) ? current : (names[0] ?? "")))
    setSnapshotRestoreOpen(true)
  }

  function closeSnapshotRestore(): void {
    snapshotRequestRef.current += 1
    setSnapshotRestoreOpen(false)
  }

  function restoreSnapshot(): void {
    const target = selectedSnapshot
    void actions.restoreSnapshot(target, () => setSnapshotRestoreOpen(false))
  }

  function showEnvironment(): void {
    const requestId = ++environmentRequestRef.current
    environmentOpenRef.current = true
    setEnvironmentOpen(true)
    setEnvironmentData(undefined)
    setEnvironmentError(undefined)
    void actions
      .showEnvironment()
      .then((data) => {
        if (
          requestId === environmentRequestRef.current &&
          environmentOpenRef.current &&
          panelOpenRef.current
        ) {
          setEnvironmentData(data)
        }
      })
      .catch((error: unknown) => {
        if (
          requestId === environmentRequestRef.current &&
          environmentOpenRef.current &&
          panelOpenRef.current
        ) {
          setEnvironmentError(error instanceof Error ? error.message : String(error))
        }
      })
  }

  function closeEnvironment(): void {
    environmentOpenRef.current = false
    environmentRequestRef.current += 1
    setEnvironmentOpen(false)
  }

  function openUpdateCheck(): void {
    setUpdateCheckOpen(true)
    void actions.showUpdateCheck()
  }

  function clearLog(): void {
    actions.clearLog()
  }

  function chooseNodeRestoreFile(): void {
    const input = fileInputRef.current
    if (!input) return
    input.value = ""
    input.click()
  }

  function toast(severity: ToastSeverity, summary: string, detail: string): void {
    actions.toast(severity, summary, detail)
  }

  const hasSubdialog =
    gitInstallOpen ||
    snapshotRestoreOpen ||
    environmentOpen ||
    updateCheckOpen ||
    nodesManagerView.isOpen

  return (
    <>
      <input
        ref={fileInputRef}
        id="cp-node-restore-file"
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const input = event.currentTarget
          const file = input.files?.[0]
          if (file) void actions.restoreNodesFromFile(file)
        }}
      />
      {view.isOpen && (
        <ControlPanelDialog
          title={t("panel.title")}
          titleId="cp-title"
          className={styles.controlPanel}
          isBackground={hasSubdialog}
          onClose={closePanel}
        >
          <div className={styles.panelContent}>
            <div className={styles.panelColumn}>
              <ControlPanelActionGroup
                title={t("panel.group.installUpdate")}
                ariaLabel={t("panel.aria.installActions")}
              >
                <Button type="button" onClick={() => setGitInstallOpen(true)}>
                  {t("panel.action.installGit")}
                </Button>
                <Button type="button" onClick={openUpdateCheck}>
                  {t("panel.action.checkUpdates")}
                </Button>
                <Button
                  className={styles.buttonWide}
                  type="button"
                  onClick={() => void actions.nodesManager.open()}
                >
                  {t("panel.action.nodesManager")}
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    void actions.startUpdateJob(
                      "panel.action.updateComfyUI",
                      API_ROUTES.UPDATE_COMFYUI,
                    )
                  }
                >
                  {t("panel.action.updateComfyUI")}
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    void actions.startUpdateJob(
                      "panel.action.updateGitNodes",
                      API_ROUTES.UPDATE_CUSTOM_NODES,
                    )
                  }
                >
                  {t("panel.action.updateGitNodes")}
                </Button>
              </ControlPanelActionGroup>
              <ControlPanelActionGroup
                title={t("panel.group.managerCache")}
                ariaLabel={t("panel.aria.managerCacheActions")}
              >
                <div
                  className={`${styles.groupStatus} ${view.managerCacheControlsEnabled ? "" : styles.groupStatusDisabled}`}
                >
                  {t(view.managerCacheStatus)}
                </div>
                <Button
                  type="button"
                  disabled={!view.managerCacheControlsEnabled}
                  onClick={() =>
                    void actions.startUpdateJob(
                      "panel.action.updateManagerCache",
                      API_ROUTES.REFRESH_MANAGER_CACHE,
                    )
                  }
                >
                  {t("panel.action.updateManagerCache")}
                </Button>
                <Button
                  variant="danger"
                  type="button"
                  disabled={!view.managerCacheControlsEnabled}
                  onClick={() => void actions.rebuildManagerCache()}
                >
                  {t("panel.action.rebuildManagerCache")}
                </Button>
              </ControlPanelActionGroup>
            </div>
            <div className={styles.panelColumn}>
              <ControlPanelActionGroup
                title={t("panel.group.snapshot")}
                ariaLabel={t("panel.aria.snapshotActions")}
              >
                <Button
                  type="button"
                  onClick={() =>
                    void actions.startUpdateJob(
                      "panel.action.saveSnapshot",
                      API_ROUTES.SNAPSHOT_SAVE,
                    )
                  }
                >
                  {t("panel.action.saveSnapshot")}
                </Button>
                <Button variant="danger" type="button" onClick={() => void openSnapshotRestore()}>
                  {t("panel.action.restoreSnapshot")}
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    void actions.runOperation(
                      "operation.openSnapshotsFolder",
                      API_ROUTES.OPEN_SNAPSHOTS,
                      {},
                    )
                  }
                >
                  {t("panel.action.openSnapshotsFolder")}
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    void actions.runOperation(
                      "operation.openCustomNodesFolder",
                      API_ROUTES.OPEN_CUSTOM_NODES,
                      {},
                    )
                  }
                >
                  {t("panel.action.openCustomNodesFolder")}
                </Button>
              </ControlPanelActionGroup>
              <ControlPanelActionGroup
                title={t("panel.group.nodeRestore")}
                ariaLabel={t("panel.aria.nodeRestoreActions")}
              >
                <Button type="button" onClick={() => void actions.backupInstalledNodes()}>
                  {t("panel.action.backupInstalledNodes")}
                </Button>
                <Button variant="danger" type="button" onClick={chooseNodeRestoreFile}>
                  {t("panel.action.restoreLatestNodes")}
                </Button>
              </ControlPanelActionGroup>
              <ControlPanelActionGroup
                title={t("panel.group.workflowMetadata")}
                ariaLabel={t("panel.aria.workflowMetadataActions")}
              >
                <Button
                  className={styles.buttonWide}
                  type="button"
                  onClick={() => void actions.repairMetadata()}
                >
                  {t("panel.action.fixWorkflowMetadata")}
                </Button>
              </ControlPanelActionGroup>
            </div>
            <div className={`${styles.panelColumn} ${styles.panelColumnStatus}`}>
              <div className={styles.actions}>
                <Button type="button" onClick={showEnvironment}>
                  {t("panel.action.showEnvironment")}
                </Button>
                <Button
                  variant="danger"
                  type="button"
                  disabled={view.restartPending}
                  onClick={() => void actions.restart()}
                >
                  {t("panel.action.restart")}
                </Button>
              </div>
              {view.restartNotice && (
                <div className={styles.restartNotice} role="status">
                  {t(view.restartNotice, view.restartNoticeValues)}
                </div>
              )}
              <div className={styles.logWrap}>
                <div className={styles.logActions}>
                  <Button
                    size="sm"
                    type="button"
                    aria-label={t("panel.action.showStatusJson")}
                    onClick={() => void actions.showStatusJson()}
                  >
                    {t("panel.action.showStatusShort")}
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    aria-label={t("panel.action.clearLog")}
                    onClick={clearLog}
                  >
                    {t("panel.action.clearLog")}
                  </Button>
                </div>
                <pre ref={logRef} className={styles.log} aria-live="polite">
                  {view.log}
                </pre>
              </div>
            </div>
          </div>
        </ControlPanelDialog>
      )}
      <NodesManagerPage
        controller={actions.nodesManager}
        onAddGitNode={() => setGitInstallOpen(true)}
        isBackground={gitInstallOpen}
      />
      <GitInstallModal
        isOpen={view.isOpen && gitInstallOpen}
        url={gitUrl}
        folderName={gitFolderName}
        onUrlChange={setGitUrl}
        onFolderNameChange={setGitFolderName}
        runOperation={(label, route, body) => void actions.runOperation(label, route, body)}
        toast={toast}
        onClose={() => setGitInstallOpen(false)}
      />
      <SnapshotRestoreModal
        isOpen={view.isOpen && snapshotRestoreOpen}
        names={snapshotNames}
        selected={selectedSnapshot}
        onSelectionChange={setSelectedSnapshot}
        onRestore={restoreSnapshot}
        onClose={closeSnapshotRestore}
      />
      <EnvironmentModal
        isOpen={view.isOpen && environmentOpen}
        data={environmentData}
        error={environmentError}
        onClose={closeEnvironment}
      />
      <UpdateCheckModal
        isOpen={view.isOpen && updateCheckOpen}
        output={view.updateCheckOutput}
        onClose={() => setUpdateCheckOpen(false)}
      />
    </>
  )
}
