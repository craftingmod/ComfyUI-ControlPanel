import { useRef } from "react"

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
  if (!isOpen) return null

  return (
    <ControlPanelDialog
      title="Restore Snapshot"
      titleId="cp-snapshot-restore-title"
      initialFocusRef={selectRef}
      onClose={onClose}
    >
      <div className={styles.field}>
        <label htmlFor="cp-snapshot-select">Snapshot</label>
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
          Cancel
        </Button>
        <Button variant="danger" type="button" disabled={!selected} onClick={onRestore}>
          Restore
        </Button>
      </div>
    </ControlPanelDialog>
  )
}
