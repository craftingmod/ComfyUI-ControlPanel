import { useRef } from "react"

import { useI18n } from "../i18n/index.tsx"
import { ControlPanelDialog } from "./controlPanelDialog.tsx"
import { Button } from "./ui/button.tsx"

import styles from "./controlPanel.module.css"

type SnapshotRestoreModalProps = {
  isOpen: boolean
  names: string[]
  selected: string
  onSelectionChange: (name: string) => void
  onRestore: () => void
  onClose: () => void
}

export function SnapshotRestoreModal({
  isOpen,
  names,
  selected,
  onSelectionChange,
  onRestore,
  onClose,
}: SnapshotRestoreModalProps) {
  const selectRef = useRef<HTMLSelectElement>(null)
  const { t } = useI18n()
  if (!isOpen) return null

  return (
    <ControlPanelDialog
      title={t("snapshot.title")}
      titleId="cp-snapshot-restore-title"
      initialFocusRef={selectRef}
      onClose={onClose}
    >
      <div className={styles.field}>
        <label htmlFor="cp-snapshot-select">{t("snapshot.field")}</label>
        <select
          ref={selectRef}
          id="cp-snapshot-select"
          name="snapshot"
          value={selected}
          onChange={(event) => onSelectionChange(event.currentTarget.value)}
        >
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.modalActions}>
        <Button type="button" onClick={onClose}>
          {t("snapshot.cancel")}
        </Button>
        <Button variant="danger" type="button" disabled={!selected} onClick={onRestore}>
          {t("snapshot.restore")}
        </Button>
      </div>
    </ControlPanelDialog>
  )
}
