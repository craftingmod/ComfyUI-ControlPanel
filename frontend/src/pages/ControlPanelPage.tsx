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
import { UpdateCheckModal } from "../components/updateCheckModal.tsx"
import { API_ROUTES } from "../constants.ts"
import type { ToastSeverity } from "../types.ts"
import { NodesManagerPage } from "./NodesManagerPage.tsx"

import styles from "../components/controlPanel.module.css"

type ControlPanelPageProps = {
  actions: ControlPanelActions
}

export function ControlPanelPage({ actions }: ControlPanelPageProps) {
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
          title="⚙️ ComfyUI-ControlPanel"
          titleId="cp-title"
          className={styles.controlPanel}
          isBackground={hasSubdialog}
          onClose={closePanel}
        >
          <div className={styles.panelContent}>
            <div className={styles.panelColumn}>
              <ControlPanelActionGroup
                title="Install / Update"
                ariaLabel="Install and update actions"
              >
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => setGitInstallOpen(true)}
                >
                  Install via Git URL
                </button>
                <button className={styles.button} type="button" onClick={openUpdateCheck}>
                  Check for Updates
                </button>
                <button
                  className={`${styles.button} ${styles.buttonWide}`}
                  type="button"
                  onClick={() => void actions.nodesManager.open()}
                >
                  Nodes Manager
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() =>
                    void actions.startUpdateJob("Update ComfyUI", API_ROUTES.UPDATE_COMFYUI)
                  }
                >
                  Update ComfyUI
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() =>
                    void actions.startUpdateJob("Update Git Nodes", API_ROUTES.UPDATE_CUSTOM_NODES)
                  }
                >
                  Update Git Nodes
                </button>
              </ControlPanelActionGroup>
              <ControlPanelActionGroup title="Manager Cache" ariaLabel="Manager cache actions">
                <div
                  className={`${styles.groupStatus} ${view.managerCacheControlsEnabled ? "" : styles.groupStatusDisabled}`}
                >
                  {view.managerCacheStatus}
                </div>
                <button
                  className={styles.button}
                  type="button"
                  disabled={!view.managerCacheControlsEnabled}
                  onClick={() =>
                    void actions.startUpdateJob(
                      "Update Manager Cache",
                      API_ROUTES.REFRESH_MANAGER_CACHE,
                    )
                  }
                >
                  Update Manager Cache
                </button>
                <button
                  className={`${styles.button} ${styles.danger}`}
                  type="button"
                  disabled={!view.managerCacheControlsEnabled}
                  onClick={() => void actions.rebuildManagerCache()}
                >
                  Rebuild Manager Cache
                </button>
              </ControlPanelActionGroup>
            </div>
            <div className={styles.panelColumn}>
              <ControlPanelActionGroup title="Snapshot" ariaLabel="Snapshot actions">
                <button
                  className={styles.button}
                  type="button"
                  onClick={() =>
                    void actions.startUpdateJob("Save Snapshot", API_ROUTES.SNAPSHOT_SAVE)
                  }
                >
                  Save Snapshot
                </button>
                <button
                  className={`${styles.button} ${styles.danger}`}
                  type="button"
                  onClick={() => void openSnapshotRestore()}
                >
                  Restore Snapshot
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() =>
                    void actions.runOperation(
                      "Open Snapshots Folder",
                      API_ROUTES.OPEN_SNAPSHOTS,
                      {},
                    )
                  }
                >
                  Open Snapshots Folder
                </button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() =>
                    void actions.runOperation(
                      "Open custom_nodes Folder",
                      API_ROUTES.OPEN_CUSTOM_NODES,
                      {},
                    )
                  }
                >
                  Open custom_nodes Folder
                </button>
              </ControlPanelActionGroup>
              <ControlPanelActionGroup
                title="Node Restore"
                ariaLabel="Custom node backup and restore actions"
              >
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => void actions.backupInstalledNodes()}
                >
                  Backup Installed Nodes
                </button>
                <button
                  className={`${styles.button} ${styles.danger}`}
                  type="button"
                  onClick={chooseNodeRestoreFile}
                >
                  Restore Latest Nodes
                </button>
              </ControlPanelActionGroup>
              <ControlPanelActionGroup
                title="Workflow Metadata"
                ariaLabel="Workflow metadata actions"
              >
                <button
                  className={`${styles.button} ${styles.buttonWide}`}
                  type="button"
                  onClick={() => void actions.repairMetadata()}
                >
                  Repair Metadata
                </button>
              </ControlPanelActionGroup>
            </div>
            <div className={`${styles.panelColumn} ${styles.panelColumnStatus}`}>
              <div className={styles.actions}>
                <button className={styles.button} type="button" onClick={showEnvironment}>
                  Show Environment
                </button>
                <button
                  className={`${styles.button} ${styles.danger} ${styles.restartButton}`}
                  type="button"
                  onClick={() => void actions.restart()}
                >
                  Restart
                </button>
              </div>
              {view.restartNotice && (
                <div className={styles.restartNotice} role="status">
                  {view.restartNotice}
                </div>
              )}
              <div className={styles.logWrap}>
                <div className={styles.logActions}>
                  <button
                    className={`${styles.button} ${styles.logAction}`}
                    type="button"
                    aria-label="Show status JSON"
                    onClick={() => void actions.showStatusJson()}
                  >
                    Show Status
                  </button>
                  <button
                    className={`${styles.button} ${styles.logClear}`}
                    type="button"
                    aria-label="Clear log"
                    onClick={clearLog}
                  >
                    Clear Log
                  </button>
                </div>
                <pre ref={logRef} className={styles.log} aria-live="polite">
                  {view.log}
                </pre>
              </div>
            </div>
          </div>
        </ControlPanelDialog>
      )}
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
      <NodesManagerPage controller={actions.nodesManager} />
    </>
  )
}
