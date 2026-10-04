import {
  Check,
  FolderGit2,
  Folder,
  HardDriveDownload,
  CircleAlert,
  LoaderCircle,
  Power,
  PowerOff,
  Download,
  RotateCwClock,
  Star,
  Trash2,
  X,
  RefreshCcw,
  Tag,
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
  onBrowse: () => void
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

function formatCount(value: number | undefined, locale: string, compact = false): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(
        compact ? "en" : locale,
        compact ? { notation: "compact", maximumFractionDigits: 2 } : undefined,
      ).format(value)
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
  onBrowse,
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
  const [versionsOpen, setVersionsOpen] = useState(false)
  const showVersionField = versionsOpen && hasLoadedVersions
  const hasVersionField =
    pack.source === "Registry" ||
    (pack.source !== "Git" && !pack.installed && Boolean(pack.latestVersion))
  const isGit = pack.source === "Git"
  const showVersionPanel = hasVersionField && versionsOpen
  const versionError =
    versionState?.error || versionState?.errorKey
      ? t("card.couldNotLoadVersions", {
          error: versionState.errorKey
            ? t(versionState.errorKey, versionState.errorValues)
            : (versionState.error ?? t("nodes.unknownError")),
        })
      : undefined
  const updateStatus = pack.latestVersion?.status?.toLocaleLowerCase()
  const installed = pack.installed
  const installedVersion = installed?.version
    ? (loadedVersions.find((version) => version.version === installed.version) ??
      [pack.latestVersion, pack.latestFlaggedVersion].find(
        (version) => version?.version === installed.version,
      ))
    : undefined
  const displayedVersion = installed
    ? installed.version
    : !updateStatus || updateStatus === "active" || updateStatus === "nodeversionstatusactive"
      ? pack.latestVersion?.version
      : undefined
  const busy = isOperationActive(operation)
  const running = operation?.status === "starting" || operation?.status === "pending"
  const canInstall =
    !installed && !pack.readOnly && pack.source === "Registry" && Boolean(selectedVersion)
  const selectedRegistryVersion = versions.find(
    (version) =>
      version.version === selectedVersion && !version.status?.toLowerCase().includes("banned"),
  )
  const canSwitch = Boolean(installed && pack.source === "Registry" && selectedRegistryVersion)
  const targetVersion = showVersionPanel ? selectedRegistryVersion : pack.latestVersion
  const selectionUnavailable =
    showVersionPanel &&
    (!showVersionField ||
      versionState?.loading ||
      Boolean(versionError) ||
      !selectedRegistryVersion)
  const updateLabel = t(
    isGit ? "card.fetch" : showVersionPanel ? "card.installSelectedVersion" : "card.update",
  )
  const updated = formatDate(pack.updatedAt, locale)
  const repositoryUrl = safeHttpsUrl(pack.repository)
  const author = pack.author || (installed ? t("toast.localInstallation") : t("card.unknownAuthor"))
  const operationMessage = operation?.messageKey
    ? t(operation.messageKey, operation.messageValues)
    : operation?.message
  const operationTooltip = operation
    ? [
        operationLabel(operation, t),
        operationMessage,
        operation.restartRequired ? t("nodes.restartRequired") : undefined,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined
  const versionButton =
    hasVersionField && !showVersionField ? (
      <Button
        size="sm"
        type="button"
        data-action="load-version"
        variant={isFlagged(installedVersion) ? "warning" : "secondary"}
        aria-label={t("card.version")}
        aria-expanded={showVersionPanel}
        aria-controls={showVersionPanel ? versionFieldId : undefined}
        title={t(installed ? "card.switchSpecificVersion" : "card.installSpecificVersion")}
        busy={versionState?.loading}
        disabled={!actionsEnabled || busy}
        onClick={() => {
          setVersionsOpen(true)
          if (!hasLoadedVersions) onLoadVersions()
        }}
      >
        <Tag size={IconSize} aria-hidden="true" />
        {displayedVersion?.slice(0, 7) || "—"}
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
        {installed && (
          <span
            className={styles.disabledIndicator}
            data-disabled={installed.enabled === false}
            role="img"
            aria-label={
              installed.enabled === false
                ? t("card.disabled")
                : t("card.installed", {
                    version: installed.version || t("card.versionUnavailable"),
                  })
            }
            title={
              installed.enabled === false
                ? t("card.disabled")
                : t("card.installed", {
                    version: installed.version || t("card.versionUnavailable"),
                  })
            }
          >
            {installed.enabled === false ? (
              <PowerOff size={IconSize * 1.5} aria-hidden="true" />
            ) : pack.source === "Git" ? (
              <FolderGit2 size={IconSize} aria-hidden="true" />
            ) : pack.source === "Local folder" ? (
              <Folder size={IconSize} aria-hidden="true" />
            ) : (
              <Check size={IconSize * 1} aria-hidden="true" />
            )}
          </span>
        )}
        {operation && (
          <span
            className={styles.operationIndicator}
            data-status={operation.status}
            data-restart={operation.restartRequired}
            role="img"
            aria-label={operationTooltip}
            title={operationTooltip}
          >
            {running ? (
              <LoaderCircle className={styles.spinner} size={IconSize} aria-hidden="true" />
            ) : operation.status === "failed" || operation.status === "unknown" ? (
              <CircleAlert size={IconSize} aria-hidden="true" />
            ) : operation.restartRequired ? (
              <RefreshCcw size={IconSize} aria-hidden="true" />
            ) : operation.status === "succeeded" ? (
              <Check size={IconSize} aria-hidden="true" />
            ) : (
              <CircleAlert size={IconSize} aria-hidden="true" />
            )}
          </span>
        )}
      </div>

      <div className={styles.contentSlot}>
        {!showVersionPanel && (
          <p className={styles.description}>{pack.description || t("card.noDescription")}</p>
        )}

        <div className={styles.metadata}>
          <span
            className={styles.downloads}
            title={`${t("card.downloads")}: ${formatCount(pack.downloads, locale)}`}
            aria-label={`${t("card.downloads")}: ${formatCount(pack.downloads, locale)}`}
          >
            <Download className={styles.metadataIcon} aria-hidden="true" />
            {formatCount(pack.downloads, locale, true)}
          </span>
          {updated && (
            <span title={updated}>
              <RotateCwClock className={styles.metadataIcon} aria-hidden="true" />
              {updated}
            </span>
          )}
          <span title={t("card.githubStars")}>
            <Star className={styles.metadataIcon} aria-hidden="true" fill="currentColor" />
            {formatCount(pack.stars, locale)}
          </span>
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

        {showVersionPanel && (
          <div
            id={versionFieldId}
            className={styles.versionField}
            data-has-retry={Boolean(versionError)}
          >
            {showVersionField && !versionError && (
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
            {(!showVersionField || versionError) && (
              <span
                className={versionError ? styles.inlineError : styles.versionPlaceholder}
                role="status"
                aria-live="polite"
                title={versionError}
              >
                {versionError ||
                  (versionState?.loading ? t("card.loadingVersions") : t("card.chooseVersion"))}
              </span>
            )}
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
            {versionError && (
              <Button
                size="sm"
                type="button"
                data-action="retry-version"
                disabled={!actionsEnabled || busy || versionState?.loading}
                onClick={onRetryVersions}
              >
                {t("nodes.retry")}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className={styles.actions}>
        {versionButton}
        {installed && (
          <Button
            size="sm"
            type="button"
            aria-busy={
              running && (operation.operation === "disable" || operation.operation === "enable")
            }
            disabled={!actionsEnabled || busy || pack.readOnly}
            onClick={() => onSubmit(installed.enabled === true ? "disable" : "enable")}
            aria-label={t(installed.enabled === true ? "card.disable" : "card.enable")}
            title={t(installed.enabled === true ? "card.disable" : "card.enable")}
          >
            {running && (operation.operation === "disable" || operation.operation === "enable") ? (
              <LoaderCircle className={styles.spinner} size={IconSize} aria-hidden="true" />
            ) : installed.enabled === true ? (
              <PowerOff size={IconSize} aria-hidden="true" />
            ) : (
              <Power size={IconSize} aria-hidden="true" />
            )}
          </Button>
        )}
        {installed && (
          <Button
            size="sm"
            variant="danger"
            type="button"
            data-action="uninstall"
            aria-busy={running && operation.operation === "uninstall"}
            aria-label={t("card.uninstall", { name: pack.name })}
            title={t("card.uninstall", { name: pack.name })}
            disabled={!actionsEnabled || busy || pack.readOnly}
            onClick={() => onSubmit("uninstall")}
          >
            {running && operation.operation === "uninstall" ? (
              <LoaderCircle className={styles.spinner} size={IconSize} aria-hidden="true" />
            ) : (
              <Trash2 className={styles.uninstallIcon} aria-hidden="true" />
            )}
          </Button>
        )}
        <div className={styles.actionsEnd}>
          {pack.source === "Local folder" && installed?.local && (
            <Button size="sm" type="button" data-action="browse" onClick={onBrowse}>
              <Folder size={IconSize} aria-hidden="true" />
              {t("card.browse")}
            </Button>
          )}
          {installed &&
            !pack.readOnly &&
            (showVersionPanel ||
              isGit ||
              pack.latestVersion?.version !== installed.version ||
              (running &&
                (operation.operation === "update" || operation.operation === "switch"))) && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  type="button"
                  data-action="update"
                  aria-busy={
                    running &&
                    (operation.operation === "update" || operation.operation === "switch")
                  }
                  data-flagged={!isGit && isFlagged(targetVersion)}
                  aria-label={
                    isGit ? updateLabel : `${updateLabel}: ${targetVersion?.version || "—"}`
                  }
                  title={isGit ? updateLabel : `${updateLabel}: ${targetVersion?.version || "—"}`}
                  disabled={
                    !actionsEnabled ||
                    busy ||
                    selectionUnavailable ||
                    (showVersionPanel && !canSwitch)
                  }
                  onClick={() =>
                    !isGit && showVersionPanel
                      ? onSubmit("switch", selectedVersion)
                      : onSubmit("update")
                  }
                >
                  {running &&
                  (operation.operation === "update" || operation.operation === "switch") ? (
                    <LoaderCircle className={styles.spinner} size={IconSize} aria-hidden="true" />
                  ) : isGit ? (
                    <HardDriveDownload size={IconSize} aria-hidden="true" />
                  ) : (
                    <Download size={IconSize} aria-hidden="true" />
                  )}
                  {isGit ? t("card.fetch") : targetVersion?.version.slice(0, 7) || "—"}
                </Button>
              </>
            )}
          {!installed && (
            <Button
              size="sm"
              variant="primary"
              type="button"
              data-action="install"
              aria-busy={running && operation.operation === "install"}
              title={pack.readOnly ? t("nodes.workflow.installUnavailable") : undefined}
              disabled={
                !actionsEnabled || busy || pack.readOnly || !canInstall || selectionUnavailable
              }
              onClick={() => onSubmit("install", selectedVersion)}
            >
              {running && operation.operation === "install" ? (
                <LoaderCircle className={styles.spinner} size={IconSize} aria-hidden="true" />
              ) : (
                <Download size={IconSize} aria-hidden="true" />
              )}
              {t("card.install")}
            </Button>
          )}
        </div>
      </div>
    </article>
  )
}
