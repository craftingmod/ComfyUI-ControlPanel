import { useEffect, useRef } from "react"

import { useI18n } from "../i18n/index.tsx"
import { ControlPanelDialog } from "./controlPanelDialog.tsx"

import styles from "./controlPanel.module.css"

type UpdateCheckModalProps = {
  isOpen: boolean
  output: string
  onClose: () => void
}

export function UpdateCheckModal({ isOpen, output, onClose }: UpdateCheckModalProps) {
  const outputRef = useRef<HTMLPreElement>(null)
  const { t } = useI18n()

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [output, isOpen])

  if (!isOpen) return null

  return (
    <ControlPanelDialog
      title={t("updateCheck.title")}
      titleId="cp-update-check-title"
      className={styles.updateCheckModal}
      onClose={onClose}
    >
      <pre ref={outputRef} className={styles.updateCheckOutput} aria-live="polite">
        {output}
      </pre>
    </ControlPanelDialog>
  )
}
