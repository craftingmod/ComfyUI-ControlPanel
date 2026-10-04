import { Download, RefreshCcw, RotateCwClock, Star, Trash2 } from "lucide-react"
import { useId } from "react"

import { useI18n, type TranslationKey, type TranslationValues } from "../i18n/index.tsx"
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
  errorKey?: TranslationKey
  errorValues?: TranslationValues
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

function formatCount(value: number | undefined, locale: string): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(locale).format(value)
    : "—"
}

function formatDate(value: string | undefined, locale: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? undefined
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date).replace(/\.$/u, "")
}

function operationLabel(
  operation: NodesManagerOperationState,
  t: (key: TranslationKey, values?: TranslationValues) => string,
): string {
  switch (operation.status) {
    case "starting":
      return t("operation.starting")
    case "pending":
      return t("operation.inProgress")
    case "unknown":
      return t("nodes.outcomeUnknown")
    case "succeeded":
      return t("operation.completed")
    case "failed":
      return t("operation.failed")
    case "skipped":
      return t("operation.skipped")
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
  const { locale, t } = useI18n()
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
  const updated = formatDate(pack.updatedAt, locale)
  const repositoryUrl = safeImageUrl(pack.repository)
  const sourceKey: TranslationKey =
    pack.source === "Registry"
      ? "card.source.registry"
      : pack.source === "Git"
        ? "card.source.git"
        : "card.source.unknown"
  const operationMessage = operation?.messageKey
    ? t(operation.messageKey, operation.messageValues)
    : operation?.message

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
        <Badge>{t(sourceKey)}</Badge>
      </div>

      <p className={styles.description}>{pack.description || t("card.noDescription")}</p>

      <div className={styles.metadata}>
        <span title={t("card.githubStars")}>
          <Star className={styles.metadataIcon} aria-hidden="true" fill="currentColor" />
          {formatCount(pack.stars, locale)}
        </span>
        <span title={t("card.downloads")}>
          <Download className={styles.metadataIcon} aria-hidden="true" />
          {formatCount(pack.downloads, locale)}
        </span>
        {updated && (
          <span title={updated}>
            <RotateCwClock className={styles.metadataIcon} aria-hidden="true" />
            {updated}
          </span>
        )}
      </div>
      <p className={styles.author}>
        {t("card.author", {
          author:
            pack.author || (installed ? t("toast.localInstallation") : t("card.unknownAuthor")),
        })}
      </p>

      {repositoryUrl ? (
        <a className={styles.repository} href={repositoryUrl} target="_blank" rel="noreferrer">
          {t("card.viewSource")}
        </a>
      ) : pack.repository ? (
        <p className={styles.repositoryText} title={pack.repository}>
          {t("card.sourceText", { source: pack.repository })}
        </p>
      ) : null}

      <div className={styles.installDetails}>
        <span>
          {installed
            ? t("card.installed", {
                version: installed.version || t("card.versionUnavailable"),
              })
            : t("card.notInstalled")}
        </span>
        {installed && (
          <span
            className={installed.enabled === false ? styles.disabledState : styles.enabledState}
          >
            {installed.enabled === false ? t("card.disabled") : t("card.enabled")}
          </span>
        )}
        {pack.latestVersion?.version && (
          <span>{t("card.latest", { version: pack.latestVersion.version })}</span>
        )}
        {pack.updateAvailable && <Badge tone="warning">{t("card.updateAvailable")}</Badge>}
      </div>

      {(pack.source === "Registry" || (!installed && pack.latestVersion)) && (
        <div className={styles.versionField}>
          <span id={versionLabelId}>{t("card.registryVersion")}</span>
          {hasLoadedVersions ? (
            <select
              id={versionId}
              name={`version-${pack.id}`}
              aria-labelledby={versionLabelId}
              value={selectedVersion}
              disabled={!actionsEnabled || busy}
              onChange={(event) => onSelectVersion(event.currentTarget.value)}
            >
              <option value="">{t("card.chooseVersion")}</option>
              {versions.map((version) => {
                const flaggedVersion = isFlagged(version)
                const status = version.status && !flaggedVersion ? ` — ${version.status}` : ""
                return (
                  <option key={version.id ?? version.version} value={version.version}>
                    {version.version}
                    {flaggedVersion ? ` — ${t("card.flaggedVersion")}` : status}
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
              busyLabel={t("card.loadingVersions")}
              disabled={!actionsEnabled || busy}
              onClick={onLoadVersions}
            >
              {t("card.chooseVersion")}
            </Button>
          )}
          {(versionState?.error || versionState?.errorKey) && (
            <div className={styles.inlineError}>
              <span>
                {t("card.couldNotLoadVersions", {
                  error: versionState.errorKey
                    ? t(versionState.errorKey, versionState.errorValues)
                    : (versionState.error ?? t("nodes.unknownError")),
                })}
              </span>
              <Button
                size="sm"
                type="button"
                disabled={!actionsEnabled || busy}
                onClick={onRetryVersions}
              >
                {t("nodes.retry")}
              </Button>
            </div>
          )}
          {flagged && (
            <p className={styles.flaggedNote} role="note">
              {t("card.flaggedNotice", {
                reason: flaggedReason ? t("card.flaggedReason", { reason: flaggedReason }) : "",
              })}
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
            {t("card.install")}
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
              <RefreshCcw size={16} />
              {t("card.update")}
            </Button>
            {pack.source === "Registry" && (
              <Button
                size="sm"
                type="button"
                disabled={!actionsEnabled || busy || !canSwitch}
                onClick={() => onSubmit("switch", selectedVersion)}
              >
                {t("card.installSelectedVersion")}
              </Button>
            )}
            <Button
              size="sm"
              type="button"
              disabled={!actionsEnabled || busy}
              onClick={() => onSubmit(installed.enabled === true ? "disable" : "enable")}
            >
              {installed.enabled === true ? t("card.disable") : t("card.enable")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              type="button"
              aria-label={t("card.uninstall", { name: pack.name })}
              title={t("card.uninstall", { name: pack.name })}
              disabled={!actionsEnabled || busy}
              onClick={() => onSubmit("uninstall")}
            >
              <Trash2 className={styles.uninstallIcon} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>

      {!actionsEnabled && (
        <p className={styles.managerUnavailable}>{t("card.managerUnavailable")}</p>
      )}
      {operation && (
        <div
          className={`${styles.operation} ${operation.status === "failed" ? styles.operationFailed : ""} ${operation.status === "unknown" ? styles.operationUnknown : ""}`}
          role={operation.status === "failed" ? "alert" : "status"}
          aria-live="polite"
        >
          <strong>{operationLabel(operation, t)}</strong>
          {operationMessage && <span>{operationMessage}</span>}
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
              {t("nodes.retryQueue")}
            </Button>
          )}
          {operation.restartRequired && (
            <span className={styles.restartNote}>{t("nodes.restartRequired")}</span>
          )}
        </div>
      )}
    </article>
  )
}
