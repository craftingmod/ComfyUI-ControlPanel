import type { ReactNode } from "react"

import styles from "./controlPanel.module.css"

type ControlPanelActionGroupProps = {
  title: string
  ariaLabel: string
  children: ReactNode
}

export function ControlPanelActionGroup({
  title,
  ariaLabel,
  children,
}: ControlPanelActionGroupProps) {
  return (
    <section className={styles.actionGroup} aria-label={ariaLabel}>
      <h3 className={styles.groupTitle}>{title}</h3>
      {children}
    </section>
  )
}
