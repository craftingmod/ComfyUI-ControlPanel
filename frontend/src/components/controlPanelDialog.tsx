import { X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"

import { useI18n } from "../i18n/index.tsx"
import { Button } from "./ui/button.tsx"

import styles from "./controlPanel.module.css"

type ControlPanelDialogProps = {
  title: string
  titleId: string
  className?: string
  initialFocusRef?: RefObject<HTMLElement | null>
  isBackground?: boolean
  onClose: () => void
  children: ReactNode
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ControlPanelDialog({
  title,
  titleId,
  className = styles.modalPanel,
  initialFocusRef,
  isBackground = false,
  onClose,
  children,
}: ControlPanelDialogProps) {
  const panelRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const { t } = useI18n()
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const activePanel = panelRef.current!
    if (!activePanel) return

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () =>
      Array.from(activePanel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.getAttribute("aria-hidden") !== "true",
      )
    const firstFocus = initialFocusRef?.current ?? focusable()[0] ?? activePanel
    firstFocus.focus()

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== "Tab") return

      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        activePanel.focus()
      } else if (
        event.shiftKey &&
        (document.activeElement === items[0] || !activePanel.contains(document.activeElement))
      ) {
        event.preventDefault()
        items[items.length - 1]?.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === items[items.length - 1] ||
          !activePanel.contains(document.activeElement))
      ) {
        event.preventDefault()
        items[0]?.focus()
      }
    }

    activePanel.addEventListener("keydown", onKeyDown)
    return () => {
      activePanel.removeEventListener("keydown", onKeyDown)
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [initialFocusRef])

  return createPortal(
    <div
      className={styles.backdrop}
      data-template-theme=""
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panelRef}
        className={`${styles.panel} ${className ?? ""}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-hidden={isBackground || undefined}
        inert={isBackground || undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <Button size="icon" type="button" aria-label={t("panel.close")} onClick={onClose}>
            <X />
          </Button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  )
}
