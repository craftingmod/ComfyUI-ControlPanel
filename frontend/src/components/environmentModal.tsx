import { Fragment } from "react"

import type { JsonObject } from "../types.ts"
import { ControlPanelDialog } from "./controlPanelDialog.tsx"

import styles from "./controlPanel.module.css"

type EnvironmentSection = {
  title: string
  rows: Array<[string, unknown]>
}

type EnvironmentModalProps = {
  isOpen: boolean
  data?: JsonObject
  error?: string
  onClose: () => void
}

function asRecord(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as JsonObject
}

function environmentSections(data: JsonObject): EnvironmentSection[] | undefined {
  const environment = asRecord(data.environment)
  if (!environment) return undefined

  const cli = asRecord(data.cli)
  const python = asRecord(environment.python)
  const config = asRecord(environment.config)
  const server = asRecord(environment.server)
  const workspace = asRecord(environment.workspace)
  return [
    {
      title: "Comfy CLI",
      rows: [
        ["Version", cli?.version],
        ["Command", cli?.command],
      ],
    },
    {
      title: "Python",
      rows: [
        ["Python Version", python?.version],
        ["Python Executable", python?.executable],
        ["Virtualenv Path", python?.virtualenv],
        ["Conda Env", python?.conda_env],
      ],
    },
    {
      title: "Workspace",
      rows: [
        ["Current selected workspace", workspace?.path],
        ["Workspace Type", workspace?.type],
        ["Manager", workspace?.manager_mode],
        ["UV Compile Default", workspace?.uv_compile_default],
      ],
    },
    {
      title: "Server",
      rows: [
        ["Comfy Server Running", server?.running],
        ["Server URL", server?.url],
      ],
    },
    {
      title: "Config",
      rows: [
        ["Config Path", config?.path],
        ["Default ComfyUI workspace", config?.default_workspace],
        ["Default ComfyUI launch extra options", config?.default_launch_extras],
        ["Recent ComfyUI workspace", config?.recent_workspace],
        ["Tracking Analytics", config?.tracking_enabled],
        ["Background ComfyUI", config?.background],
      ],
    },
  ]
}

function environmentValueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : (JSON.stringify(value) ?? "Not set")
}

export function EnvironmentModal({ isOpen, data, error, onClose }: EnvironmentModalProps) {
  if (!isOpen) return null
  const sections = data ? environmentSections(data) : undefined
  const result = asRecord(data?.result)
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : ""

  return (
    <ControlPanelDialog
      title="Comfy CLI Environment"
      titleId="cp-environment-title"
      className={styles.environmentModal}
      onClose={onClose}
    >
      <div className={styles.environmentOutput} aria-live="polite">
        {error ? (
          error
        ) : !data ? (
          "Loading comfy env..."
        ) : !sections ? (
          <pre className={styles.environmentFallback}>{JSON.stringify(data, null, 2)}</pre>
        ) : (
          <>
            <table className={styles.environmentTable}>
              <thead>
                <tr>
                  <th scope="col">Environment</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => (
                  <Fragment key={section.title}>
                    <tr className={styles.environmentSectionRow}>
                      <th scope="rowgroup" colSpan={2}>
                        {section.title}
                      </th>
                    </tr>
                    {section.rows.map(([label, value]) => (
                      <tr key={label}>
                        <th scope="row">{label}</th>
                        <td>{environmentValueText(value)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {stderr && (
              <pre className={`${styles.environmentFallback} ${styles.environmentStderr}`}>
                {`stderr\n${stderr}`}
              </pre>
            )}
          </>
        )}
      </div>
    </ControlPanelDialog>
  )
}
