import {
  CloudDownload,
  CloudCheck,
  CloudLightning,
  CloudOff,
  Download,
  RefreshCcw,
  RotateCwClock,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { useId, useState } from "react"

import { useI18n, type TranslationKey, type TranslationValues } from "../i18n/index.tsx"
import {
  safeImageUrl,
  safeHttpsUrl,
  type ManagedPack,
  type ManagerOperation,
  type RegistryVersion,
} from "../services/nodesManager.ts"
import type { NodesManagerOperationState } from "../services/nodesManagerController.ts"
import { Badge } from "./ui/badge.tsx"
import { Button } from "./ui/button.tsx"

import styles from "./nodesManagerCard.module.css"

const IconSize = 16

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

function versionLabel(version: RegistryVersion): string {
  const status = version.status?.replace(/^NodeVersionStatus/i, "").toLowerCase()
  const postfix =
    status === "flagged"
      ? "Flagged"
      : status === "pending"
        ? "Pending"
        : status === "banned"
          ? "BANNED"
          : undefined
  return postfix ? `${version.version} (${postfix})` : version.version
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
  const versionFieldId = useId()
  const iconUrl = safeImageUrl(pack.icon)
  const loadedVersions = versionState?.values ?? []
  const hasLoadedVersions = versionState?.values !== undefined
  const versions = hasLoadedVersions
    ? loadedVersions
    : pack.latestVersion
      ? [pack.latestVersion]
      : []
  const [versionsOpen, setVersionsOpen] = useState(hasLoadedVersions)
  const showVersionField = versionsOpen && hasLoadedVersions
  const hasVersionField =
    pack.source === "Registry" || (!pack.installed && Boolean(pack.latestVersion))
  const updateStatus = pack.latestVersion?.status?.toLocaleLowerCase()
  const installed = pack.installed
  const busy = isOperationActive(operation)
  const canInstall = !installed && pack.source === "Registry" && Boolean(selectedVersion)
  const canSwitch = Boolean(installed && pack.source === "Registry" && selectedVersion)
  const updated = formatDate(pack.updatedAt, locale)
  const repositoryUrl = safeHttpsUrl(pack.repository)
  const author = pack.author || (installed ? t("toast.localInstallation") : t("card.unknownAuthor"))
  const operationMessage = operation?.messageKey
    ? t(operation.messageKey, operation.messageValues)
    : operation?.message
  const versionButton =
    hasVersionField && !showVersionField ? (
      <Button
        size="sm"
        type="button"
        data-action="load-version"
        aria-label={t("card.version")}
        aria-expanded={showVersionField}
        aria-controls={showVersionField ? versionFieldId : undefined}
        title={t(installed ? "card.switchSpecificVersion" : "card.installSpecificVersion")}
        busy={versionState?.loading}
        busyLabel={t("card.loadingVersions")}
        disabled={!actionsEnabled || busy}
        onClick={() => {
          setVersionsOpen(true)
          if (!hasLoadedVersions) onLoadVersions()
        }}
      >
        <CloudLightning size={IconSize} aria-hidden="true" />
        {t("card.version")}
      </Button>
    ) : null

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
      </div>

      {(installed || pack.updateAvailable) && (
        <div className={styles.installDetails}>
          {pack.source === "Git" && <Badge>{t("card.source.git")}</Badge>}
          {installed && (
            <Badge
              tone="muted"
              title={t("card.installed", {
                version: installed.version || t("card.versionUnavailable"),
              })}
            >
              {pack.source === "Git"
                ? installed.version?.slice(0, 6) || t("card.versionUnavailable")
                : installed.version || t("card.versionUnavailable")}
            </Badge>
          )}
          {pack.updateAvailable && (
            <Badge
              tone={
                isFlagged(pack.latestVersion)
                  ? "warning"
                  : updateStatus === "active" || updateStatus === "nodeversionstatusactive"
                    ? "success"
                    : "muted"
              }
              title={t("card.updateAvailable")}
              aria-label={
                pack.latestVersion?.version
                  ? `${t("card.updateAvailable")}: ${pack.latestVersion.version}`
                  : t("card.updateAvailable")
              }
            >
              <Upload className={styles.metadataIcon} aria-hidden="true" />
              {pack.latestVersion?.version || t("card.updateAvailable")}
            </Badge>
          )}
          {installed?.enabled === false && <Badge tone="warning">{t("card.disabled")}</Badge>}
        </div>
      )}

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
        <p className={styles.author} title={author}>
          {t("card.author", { author: "" })}
          {repositoryUrl ? (
            <a
              className={styles.repository}
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
              title={t("card.viewSource")}
            >
              {author}
            </a>
          ) : (
            author
          )}
        </p>
      </div>

      {hasVersionField && (showVersionField || versionState?.error || versionState?.errorKey) && (
        <div id={versionFieldId} className={styles.versionField} data-has-switch={showVersionField}>
          {showVersionField && (
            <select
              id={versionId}
              name={`version-${pack.id}`}
              aria-label={t("card.registryVersion")}
              value={selectedVersion}
              disabled={!actionsEnabled || busy}
              onChange={(event) => onSelectVersion(event.currentTarget.value)}
            >
              <option value="">{t("card.chooseVersion")}</option>
              {versions
                .filter((version) => !version.status?.toLowerCase().includes("banned"))
                .map((version) => (
                  <option key={version.id ?? version.version} value={version.version}>
                    {versionLabel(version)}
                  </option>
                ))}
            </select>
          )}
          {showVersionField && (
            <Button
              size="sm"
              type="button"
              data-action="cancel-version"
              aria-label={t("dialog.cancel")}
              title={t("dialog.cancel")}
              onClick={() => setVersionsOpen(false)}
            >
              <X size={IconSize} aria-hidden="true" />
            </Button>
          )}
          {showVersionField && (
            <Button
              size="sm"
              type="button"
              data-action="switch-version"
              aria-label={t("card.installSelectedVersion")}
              title={t("card.installSelectedVersion")}
              disabled={!actionsEnabled || busy || !(canSwitch || canInstall)}
              onClick={() => onSubmit(installed ? "switch" : "install", selectedVersion)}
            >
              <CloudLightning size={IconSize} aria-hidden="true" />
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
        </div>
      )}

      <div className={styles.actions}>
        {versionButton}
        {installed && (
          <Button
            size="sm"
            type="button"
            disabled={!actionsEnabled || busy}
            onClick={() => onSubmit(installed.enabled === true ? "disable" : "enable")}
          >
            {installed.enabled === true ? (
              <CloudOff size={IconSize} aria-hidden="true" />
            ) : (
              <CloudCheck size={IconSize} aria-hidden="true" />
            )}
            {installed.enabled === true ? t("card.disable") : t("card.enable")}
          </Button>
        )}
        <div className={styles.actionsEnd}>
          {installed && (
            <>
              <Button
                size="sm"
                variant="danger"
                type="button"
                data-action="uninstall"
                aria-label={t("card.uninstall", { name: pack.name })}
                title={t("card.uninstall", { name: pack.name })}
                disabled={!actionsEnabled || busy}
                onClick={() => onSubmit("uninstall")}
              >
                <Trash2 className={styles.uninstallIcon} aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                variant="primary"
                type="button"
                data-action="update"
                disabled={!actionsEnabled || busy}
                onClick={() => onSubmit("update")}
              >
                <RefreshCcw size={IconSize} aria-hidden="true" />
                {t("card.update")}
              </Button>
            </>
          )}
          {!installed && (
            <Button
              size="sm"
              variant="primary"
              type="button"
              data-action="install"
              disabled={!actionsEnabled || busy || !canInstall}
              onClick={() => onSubmit("install", selectedVersion)}
            >
              <CloudDownload size={IconSize} aria-hidden="true" />
              {t("card.install")}
            </Button>
          )}
        </div>
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
