import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react"

import { cx } from "../../styles/cx.ts"

import styles from "./button.module.css"

export type ButtonVariant = "primary" | "secondary" | "danger" | "warning" | "ghost"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "sm" | "md" | "icon"
  variant?: ButtonVariant
  busy?: boolean
  busyLabel?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    busy = false,
    busyLabel,
    className,
    children,
    disabled,
    type = "button",
    "aria-busy": ariaBusy,
    ...props
  },
  ref,
) {
  const classes = cx(styles.button, className)
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classes}
      data-ui="button"
      data-size={size}
      data-state={busy ? "busy" : undefined}
      data-variant={variant}
      disabled={disabled || busy}
      aria-busy={busy || ariaBusy || undefined}
    >
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  )
})
