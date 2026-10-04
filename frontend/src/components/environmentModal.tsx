import { Fragment } from "react"

import { useI18n, type TranslationKey } from "../i18n/index.tsx"
import type { JsonObject } from "../types.ts"
import { ControlPanelDialog } from "./controlPanelDialog.tsx"

import styles from "./controlPanel.module.css"

type EnvironmentSection = {
  title: TranslationKey
  rows: Array<[TranslationKey, unknown]>
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
      title: "environment.cli",
      rows: [
        ["environment.version", cli?.version],
        ["environment.command", cli?.command],
      ],
    },
    {
      title: "environment.python",
      rows: [
        ["environment.pythonVersion", python?.version],
        ["environment.pythonExecutable", python?.executable],
        ["environment.virtualenvPath", python?.virtualenv],
        ["environment.condaEnvironment", python?.conda_env],
      ],
    },
    {
      title: "environment.workspace",
      rows: [
        ["environment.selectedWorkspace", workspace?.path],
        ["environment.workspaceType", workspace?.type],
        ["environment.manager", workspace?.manager_mode],
        ["environment.uvCompileDefault", workspace?.uv_compile_default],
      ],
    },
    {
      title: "environment.server",
      rows: [
        ["environment.serverRunning", server?.running],
        ["environment.serverUrl", server?.url],
      ],
    },
    {
      title: "environment.config",
      rows: [
        ["environment.configPath", config?.path],
        ["environment.defaultWorkspace", config?.default_workspace],
        ["environment.defaultLaunchOptions", config?.default_launch_extras],
        ["environment.recentWorkspace", config?.recent_workspace],
        ["environment.trackingAnalytics", config?.tracking_enabled],
        ["environment.backgroundComfyUI", config?.background],
      ],
    },
  ]
}

function environmentValueText(value: unknown, t: (key: TranslationKey) => string): string {
  if (value === null || value === undefined || value === "") return t("environment.notSet")
  if (typeof value === "boolean") return value ? t("environment.yes") : t("environment.no")
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : (JSON.stringify(value) ?? t("environment.notSet"))
}

export function EnvironmentModal({ isOpen, data, error, onClose }: EnvironmentModalProps) {
  const { t } = useI18n()
  if (!isOpen) return null
  const sections = data ? environmentSections(data) : undefined
  const result = asRecord(data?.result)
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : ""

  return (
    <ControlPanelDialog
      title={t("environment.title")}
      titleId="cp-environment-title"
      className={styles.environmentModal}
      onClose={onClose}
    >
      <div className={styles.environmentOutput} aria-live="polite">
        {error ? (
          error
        ) : !data ? (
          t("environment.loading")
        ) : !sections ? (
          <pre className={styles.environmentFallback}>{JSON.stringify(data, null, 2)}</pre>
        ) : (
          <>
            <table className={styles.environmentTable}>
              <thead>
                <tr>
                  <th scope="col">{t("environment.heading")}</th>
                  <th scope="col">{t("environment.value")}</th>
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => (
                  <Fragment key={section.title}>
                    <tr className={styles.environmentSectionRow}>
                      <th scope="rowgroup" colSpan={2}>
                        {t(section.title)}
                      </th>
                    </tr>
                    {section.rows.map(([label, value]) => (
                      <tr key={label}>
                        <th scope="row">{t(label)}</th>
                        <td>{environmentValueText(value, t)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {stderr && (
              <pre className={`${styles.environmentFallback} ${styles.environmentStderr}`}>
                {`${t("environment.stderr")}\n${stderr}`}
              </pre>
            )}
          </>
        )}
      </div>
    </ControlPanelDialog>
  )
}
