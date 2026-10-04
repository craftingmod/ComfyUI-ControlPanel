import { useRef } from "react"

import { API_ROUTES } from "../constants.ts"
import { useI18n, type TranslationKey } from "../i18n/index.tsx"
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
  runOperation: (label: TranslationKey, route: string, body?: Record<string, unknown>) => void
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
  const { t } = useI18n()
  if (!isOpen) return null

  function install(): void {
    const normalizedUrl = url.trim()
    if (!normalizedUrl) {
      toast("warn", "ComfyUI-ControlPanel", t("git.urlRequired"))
      urlInputRef.current?.focus()
      return
    }
    const normalizedFolder = folderName.trim()
    onClose()
    runOperation("git.title", API_ROUTES.INSTALL_GIT_URL, {
      url: normalizedUrl,
      ...(normalizedFolder ? { name: normalizedFolder } : {}),
    })
  }

  return (
    <ControlPanelDialog
      title={t("git.title")}
      titleId="cp-git-install-title"
      initialFocusRef={urlInputRef}
      onClose={onClose}
    >
      <div className={styles.grid}>
        <div className={`${styles.field} ${styles.fieldWide}`}>
          <label htmlFor="cp-git-url">{t("git.urlLabel")}</label>
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
          <label htmlFor="cp-folder-name">{t("git.folderLabel")}</label>
          <input
            id="cp-folder-name"
            name="folderName"
            autoComplete="off"
            placeholder={t("git.folderOptional")}
            value={folderName}
            onChange={(event) => onFolderNameChange(event.currentTarget.value)}
          />
        </div>
      </div>
      <div className={styles.modalActions}>
        <Button type="button" onClick={onClose}>
          {t("dialog.cancel")}
        </Button>
        <Button type="button" variant="danger" onClick={install}>
          {t("git.install")}
        </Button>
      </div>
    </ControlPanelDialog>
  )
}
