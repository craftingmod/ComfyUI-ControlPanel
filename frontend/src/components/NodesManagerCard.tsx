import { Download, RotateCwClock, Star, Trash2 } from "lucide-react"
import { useId } from "react"

import {
  safeImageUrl,
  type ManagedPack,
  type ManagerOperation,
  type RegistryVersion,
} from "../services/nodesManager.ts"
import type { NodesManagerOperationState } from "../services/nodesManagerController.ts"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"

import styles from "./nodesManagerCard.module.css"

type VersionState = {
  loading: boolean
  error?: string
  values?: RegistryVersion[]
}

type NodesManagerCardProps = {
  pack: ManagedPack
  operation?: NodesManagerOperationState
  versionState?: VersionState
  selectedVersion: string
  actionsEnabled: boolean
  onLoadVersions: () => void
  onRetryVersions: () => void
  onSelectVersion: (version: string) => void
  onSubmit: (operation: ManagerOperation, version?: string) => void
  onRetryQueueStart: () => void
}

function isFlagged(version: RegistryVersion | undefined): boolean {
  return version?.status?.toLocaleLowerCase().includes("flagged") ?? false
}

function statusReason(version: RegistryVersion | undefined): string | undefined {
  const reason = version?.status_reason
  if (typeof reason === "string") return reason.trim() || undefined
  if (reason && typeof reason === "object") {
    try {
      return JSON.stringify(reason)
    } catch {
      return undefined
    }
  }
  return undefined
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat().format(value)
    : "—"
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? undefined
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date).replace(/\.$/u, "")
}

function operationLabel(operation: NodesManagerOperationState): string {
  switch (operation.status) {
    case "starting":
      return "Starting…"
    case "pending":
      return "In progress"
    case "unknown":
      return "Outcome unknown"
    case "succeeded":
      return "Completed"
    case "failed":
      return "Failed"
    case "skipped":
      return "Skipped, no changes applied"
  }
}

function isOperationActive(operation: NodesManagerOperationState | undefined): boolean {
  return Boolean(operation && ["starting", "pending", "unknown"].includes(operation.status))
}

export function NodesManagerCard({
  pack,
  operation,
  versionState,
  selectedVersion,
  actionsEnabled,
  onLoadVersions,
  onRetryVersions,
  onSelectVersion,
  onSubmit,
  onRetryQueueStart,
}: NodesManagerCardProps) {
  const titleId = useId()
  const versionId = useId()
  const versionLabelId = useId()
  const iconUrl = safeImageUrl(pack.icon)
  const loadedVersions = versionState?.values ?? []
  const versions =
    pack.latestVersion &&
    !loadedVersions.some((version) => version.version === pack.latestVersion?.version)
      ? [pack.latestVersion, ...loadedVersions]
      : loadedVersions
  const hasLoadedVersions = versionState?.values !== undefined
  const selected = versions.find((version) => version.version === selectedVersion)
  const flagged = isFlagged(selected)
  const flaggedReason = statusReason(selected)
  const installed = pack.installed
  const busy = isOperationActive(operation)
  const canInstall = !installed && pack.source === "Registry" && Boolean(selectedVersion)
  const canSwitch = Boolean(installed && pack.source === "Registry" && selectedVersion)
  const updated = formatDate(pack.updatedAt)
  const repositoryUrl = safeImageUrl(pack.repository)

  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <div className={styles.cardHead}>
        <div className={styles.icon} aria-hidden="true">
          <span>{(pack.name.trim()[0] ?? "?").toLocaleUpperCase()}</span>
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              width={52}
              height={52}
              loading="lazy"
              onError={(event) => {
                event.currentTarget.hidden = true
              }}
            />
          ) : null}
        </div>
        <div className={styles.heading}>
          <h4 id={titleId} title={pack.name} translate="no">
            {pack.name}
          </h4>
          <p title={pack.id} translate="no">
            {pack.id}
          </p>
        </div>
        <Badge>{pack.source}</Badge>
      </div>

      <p className={styles.description}>{pack.description || "No description provided."}</p>

      <div className={styles.metadata}>
        <span title="GitHub stars">
          <Star className={styles.metadataIcon} aria-hidden="true" fill="currentColor" />
          {formatCount(pack.stars)}
        </span>
        <span title="Downloads">
          <Download className={styles.metadataIcon} aria-hidden="true" />
          {formatCount(pack.downloads)}
        </span>
        {updated && (
          <span title={updated}>
            <RotateCwClock className={styles.metadataIcon} aria-hidden="true" />
            {updated}
          </span>
        )}
      </div>
      <p className={styles.author}>By {pack.author || "Unknown author"}</p>

      {repositoryUrl ? (
        <a className={styles.repository} href={repositoryUrl} target="_blank" rel="noreferrer">
          View source ↗
        </a>
      ) : pack.repository ? (
        <p className={styles.repositoryText} title={pack.repository}>
          Source: {pack.repository}
        </p>
      ) : null}

      <div className={styles.installDetails}>
        <span>
          {installed ? `Installed: ${installed.version || "version unavailable"}` : "Not installed"}
        </span>
        {installed && (
          <span
            className={installed.enabled === false ? styles.disabledState : styles.enabledState}
          >
            {installed.enabled === false ? "Disabled" : "Enabled"}
          </span>
        )}
        {pack.latestVersion?.version && <span>Latest: {pack.latestVersion.version}</span>}
        {pack.updateAvailable && <Badge tone="warning">Update available</Badge>}
      </div>

      {(pack.source === "Registry" || (!installed && pack.latestVersion)) && (
        <div className={styles.versionField}>
          <span id={versionLabelId}>Registry version</span>
          {hasLoadedVersions ? (
            <select
              id={versionId}
              name={`version-${pack.id}`}
              aria-labelledby={versionLabelId}
              value={selectedVersion}
              disabled={!actionsEnabled || busy}
              onChange={(event) => onSelectVersion(event.currentTarget.value)}
            >
              <option value="">Choose a version…</option>
              {versions.map((version) => {
                const flaggedVersion = isFlagged(version)
                const status = version.status && !flaggedVersion ? ` — ${version.status}` : ""
                return (
                  <option key={version.id ?? version.version} value={version.version}>
                    {version.version}
                    {flaggedVersion ? " — Flagged" : status}
                  </option>
                )
              })}
            </select>
          ) : (
            <Button
              size="sm"
              type="button"
              data-action="load-version"
              busy={versionState?.loading}
              busyLabel="Loading versions…"
              disabled={!actionsEnabled || busy}
              onClick={onLoadVersions}
            >
              Choose a version…
            </Button>
          )}
          {versionState?.error && (
            <div className={styles.inlineError}>
              <span>Could not load versions: {versionState.error}</span>
              <Button
                size="sm"
                type="button"
                disabled={!actionsEnabled || busy}
                onClick={onRetryVersions}
              >
                Retry
              </Button>
            </div>
          )}
          {flagged && (
            <p className={styles.flaggedNote} role="note">
              Flagged Registry version{flaggedReason ? `: ${flaggedReason}` : "."} ComfyUI-Manager
              policy still controls whether it can be installed.
            </p>
          )}
        </div>
      )}

      <div className={styles.actions}>
        {!installed && (
          <Button
            size="sm"
            variant="primary"
            type="button"
            disabled={!actionsEnabled || busy || !canInstall}
            onClick={() => onSubmit("install", selectedVersion)}
          >
            Install
          </Button>
        )}
        {installed && (
          <>
            <Button
              size="sm"
              variant="primary"
              type="button"
              disabled={!actionsEnabled || busy}
              onClick={() => onSubmit("update")}
            >
              Update
            </Button>
            {pack.source === "Registry" && (
              <Button
                size="sm"
                type="button"
                disabled={!actionsEnabled || busy || !canSwitch}
                onClick={() => onSubmit("switch", selectedVersion)}
              >
                Install selected version
              </Button>
            )}
            <Button
              size="sm"
              type="button"
              disabled={!actionsEnabled || busy}
              onClick={() => onSubmit(installed.enabled === true ? "disable" : "enable")}
            >
              {installed.enabled === true ? "Disable" : "Enable"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              type="button"
              aria-label={`Uninstall ${pack.name}`}
              title={`Uninstall ${pack.name}`}
              disabled={!actionsEnabled || busy}
              onClick={() => onSubmit("uninstall")}
            >
              <Trash2 className={styles.uninstallIcon} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>

      {!actionsEnabled && (
        <p className={styles.managerUnavailable}>
          Actions are unavailable until ComfyUI-Manager installed-node data loads.
        </p>
      )}
      {operation && (
        <div
          className={`${styles.operation} ${operation.status === "failed" ? styles.operationFailed : ""} ${operation.status === "unknown" ? styles.operationUnknown : ""}`}
          role={operation.status === "failed" ? "alert" : "status"}
          aria-live="polite"
        >
          <strong>{operationLabel(operation)}</strong>
          {operation.message && <span>{operation.message}</span>}
          {operation.queueStartFailed && (
            <Button
              size="sm"
              className={styles.retryQueueButton}
              type="button"
              disabled={
                !actionsEnabled || operation.status === "starting" || operation.status === "pending"
              }
              onClick={onRetryQueueStart}
            >
              Retry Queue Start
            </Button>
          )}
          {operation.restartRequired && (
            <span className={styles.restartNote}>Restart ComfyUI to load this change.</span>
          )}
        </div>
      )}
    </article>
  )
}
