import { forwardRef, type HTMLAttributes } from "react"

import { cx } from "../../styles/cx.ts"

import styles from "./badge.module.css"

export type BadgeTone = "accent" | "warning" | "muted"
export type BadgeSize = "sm" | "md"

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  size?: BadgeSize
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = "accent", size = "md", className, ...props },
  ref,
) {
  const classes = cx(styles.badge, className)
  return (
    <span
      {...props}
      ref={ref}
      className={classes}
      data-ui="badge"
      data-tone={tone}
      data-size={size}
    />
  )
})
