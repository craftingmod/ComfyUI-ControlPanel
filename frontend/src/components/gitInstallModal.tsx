import { useRef } from "react"

import { API_ROUTES } from "../constants.ts"
import type { ToastSeverity } from "../types.ts"
import { ControlPanelDialog } from "./controlPanelDialog.tsx"
import { Button } from "./ui/button.tsx"

import styles from "./controlPanel.module.css"

type GitInstallModalProps = {
  isOpen: boolean
  url: string
  folderName: string
  onUrlChange: (value: string) => void
  onFolderNameChange: (value: string) => void
  runOperation: (label: string, route: string, body?: Record<string, unknown>) => void
  toast: (severity: ToastSeverity, summary: string, detail: string) => void
  onClose: () => void
}

export function GitInstallModal({
  isOpen,
  url,
  folderName,
  onUrlChange,
  onFolderNameChange,
  runOperation,
  toast,
  onClose,
}: GitInstallModalProps) {
  const urlInputRef = useRef<HTMLInputElement>(null)
  if (!isOpen) return null

  function install(): void {
    const normalizedUrl = url.trim()
    if (!normalizedUrl) {
      toast("warn", "ComfyUI-ControlPanel", "Git URL is required.")
      urlInputRef.current?.focus()
      return
    }
    const normalizedFolder = folderName.trim()
    onClose()
    runOperation("Install via Git URL", API_ROUTES.INSTALL_GIT_URL, {
      url: normalizedUrl,
      ...(normalizedFolder ? { name: normalizedFolder } : {}),
    })
  }

  return (
    <ControlPanelDialog
      title="Install via Git URL"
      titleId="cp-git-install-title"
      initialFocusRef={urlInputRef}
      onClose={onClose}
    >
      <div className={styles.grid}>
        <div className={`${styles.field} ${styles.fieldWide}`}>
          <label htmlFor="cp-git-url">Git URL</label>
          <input
            ref={urlInputRef}
            id="cp-git-url"
            name="gitUrl"
            autoComplete="off"
            placeholder="https://github.com/user/comfyui-node-pack.git"
            value={url}
            onChange={(event) => onUrlChange(event.currentTarget.value)}
          />
        </div>
        <div className={`${styles.field} ${styles.fieldWide}`}>
          <label htmlFor="cp-folder-name">Folder name</label>
          <input
            id="cp-folder-name"
            name="folderName"
            autoComplete="off"
            placeholder="Optional"
            value={folderName}
            onChange={(event) => onFolderNameChange(event.currentTarget.value)}
          />
        </div>
      </div>
      <div className={styles.modalActions}>
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={install}>
          Install
        </Button>
      </div>
    </ControlPanelDialog>
  )
}
