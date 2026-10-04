import { HardDriveDownload, Download, RefreshCw, X } from "lucide-react"
import {
  forwardRef,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { ScrollerProps } from "react-virtuoso"
import { Virtuoso, type Components, type VirtuosoHandle } from "react-virtuoso"

import { ControlPanelDialog } from "../components/controlPanelDialog.tsx"
import { NodesManagerCard } from "../components/NodesManagerCard.tsx"
import { Button } from "../components/ui/button.tsx"
import { useI18n, type TranslationKey } from "../i18n/index.tsx"
import {
  filterAndSortManagedPacks,
  type ManagerOperation,
  type NodesManagerFilter,
  type NodesManagerSort,
} from "../services/nodesManager.ts"
import type {
  NodesManagerController,
  NodesManagerOperationState,
} from "../services/nodesManagerController.ts"
import { findOperationForPack } from "../services/nodesManagerController.ts"

import styles from "./nodesManager.module.css"

const FILTER_GROUPS: {
  key: TranslationKey
  filters: { id: NodesManagerFilter; key: TranslationKey }[]
}[] = [
  {
    key: "nodes.browse",
    filters: [
      { id: "all", key: "nodes.filter.all" },
      { id: "not-installed", key: "nodes.filter.notInstalled" },
    ],
  },
  {
    key: "nodes.group.installed",
    filters: [
      { id: "installed", key: "nodes.filter.installed" },
      { id: "git", key: "nodes.filter.git" },
      { id: "local", key: "nodes.filter.local" },
    ],
  },
  {
    key: "nodes.group.status",
    filters: [
      { id: "updates", key: "nodes.filter.updates" },
      { id: "disabled", key: "nodes.filter.disabled" },
    ],
  },
  {
    key: "nodes.group.workflow",
    filters: [
      { id: "workflow", key: "nodes.filter.workflow" },
      { id: "workflow-missing", key: "nodes.filter.workflowMissing" },
    ],
  },
]
const FILTERS = FILTER_GROUPS.flatMap((group) => group.filters)

const ExtensionScroller = forwardRef<HTMLDivElement, ScrollerProps>(
  function ExtensionScroller(props, ref) {
    const { t } = useI18n()
    return (
      <div
        {...props}
        ref={ref}
        className={styles.cardViewport}
        tabIndex={props.tabIndex ?? 0}
        role="region"
        aria-label={t("nodes.aria.extensions")}
      />
    )
  },
)

const VIRTUOSO_COMPONENTS = { Scroller: ExtensionScroller } satisfies Components

type NodesManagerPageProps = {
  controller: NodesManagerController
}

export function NodesManagerPage({ controller }: NodesManagerPageProps) {
  const { locale, t } = useI18n()
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const [filter, setFilter] = useState<NodesManagerFilter>("all")
  const [sort, setSort] = useState<NodesManagerSort>("downloads")
  const [search, setSearch] = useState("")
  const [columnCount, setColumnCount] = useState(1)
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({})
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const deferredSearch = useDeferredValue(search)
  const workflowFilter = filter === "workflow" || filter === "workflow-missing"
  const categoryPacks =
    filter === "workflow"
      ? snapshot.workflowPacks
      : filter === "workflow-missing"
        ? snapshot.workflowMissingPacks
        : snapshot.packs

  const filteredPacks = useMemo(
    () => filterAndSortManagedPacks(categoryPacks, filter, deferredSearch, sort),
    [categoryPacks, filter, deferredSearch, sort],
  )
  const formattedCount = new Intl.NumberFormat(locale).format(filteredPacks.length)

  function operationStatusLabel(status: NodesManagerOperationState["status"]): string {
    switch (status) {
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

  function operationName(operation: ManagerOperation): string {
    switch (operation) {
      case "install":
        return t("card.install")
      case "update":
        return t("card.update")
      case "switch":
        return t("card.installSelectedVersion")
      case "disable":
        return t("card.disable")
      case "enable":
        return t("card.enable")
      case "uninstall":
        return t("card.uninstall", { name: "" }).trim()
    }
  }

  function operationMessage(operation: NodesManagerOperationState): string | undefined {
    return operation.messageKey
      ? t(operation.messageKey, operation.messageValues)
      : operation.message
  }
  const packRows = useMemo(() => {
    const rows: (typeof filteredPacks)[] = []
    for (let index = 0; index < filteredPacks.length; index += columnCount) {
      rows.push(filteredPacks.slice(index, index + columnCount))
    }
    return rows
  }, [columnCount, filteredPacks])
  const taskOperations = Object.values(snapshot.operations).reverse()
  const counts = useMemo(() => {
    const value: Record<NodesManagerFilter, number> = {
      all: snapshot.packs.length,
      "not-installed": 0,
      installed: 0,
      updates: 0,
      disabled: 0,
      git: 0,
      local: 0,
      workflow: snapshot.workflowPacks.length,
      "workflow-missing": snapshot.workflowMissingPacks.length,
    }
    for (const pack of snapshot.packs) {
      if (pack.installed) value.installed += 1
      else value["not-installed"] += 1
      if (pack.updateAvailable) value.updates += 1
      if (pack.installed?.enabled === false) value.disabled += 1
      if (pack.source === "Git") value.git += 1
      if (pack.source === "Local folder") value.local += 1
    }
    return value
  }, [snapshot.packs, snapshot.workflowPacks, snapshot.workflowMissingPacks])
  const workflowDiagnostics = useMemo(() => {
    if (!workflowFilter) return []
    const query = deferredSearch.trim().toLocaleLowerCase()
    return snapshot.workflowDiagnostics.filter((diagnostic) =>
      [diagnostic.type, ...(diagnostic.candidates ?? [])].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    )
  }, [deferredSearch, snapshot.workflowDiagnostics, workflowFilter])
  const unresolvedDiagnosticCount = workflowDiagnostics
    .filter((diagnostic) => diagnostic.kind === "unresolved" || diagnostic.kind === "ambiguous")
    .reduce((total, diagnostic) => total + diagnostic.occurrences, 0)
  const unavailableNodeCount = workflowDiagnostics
    .filter((diagnostic) => diagnostic.kind === "unavailable")
    .reduce((total, diagnostic) => total + diagnostic.occurrences, 0)

  const observeScroller = useCallback((element: HTMLElement | null | Window) => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    if (!(element instanceof HTMLElement) || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const style = getComputedStyle(element)
      const minCardWidth =
        Number.parseFloat(style.getPropertyValue("--nodes-manager-card-min-width")) || 300
      const gap = Number.parseFloat(style.getPropertyValue("--space-md")) || 0
      const nextColumnCount = Math.max(
        1,
        Math.floor((entry.contentRect.width + gap) / (minCardWidth + gap)),
      )
      setColumnCount((current) => (current === nextColumnCount ? current : nextColumnCount))
    })
    observer.observe(element)
    resizeObserverRef.current = observer
  }, [])

  useEffect(() => () => resizeObserverRef.current?.disconnect(), [])

  useEffect(() => {
    const resetFrame = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollTo({ top: 0, behavior: "auto" })
    })
    return () => cancelAnimationFrame(resetFrame)
  }, [deferredSearch, filter, sort])

  function ensureVersions(pack: Parameters<NodesManagerController["loadVersions"]>[0]): void {
    const state = controller.getSnapshot().versions[pack.key]
    if (!state?.loading && !state?.values) void controller.loadVersions(pack)
  }

  function retryVersions(pack: Parameters<NodesManagerController["loadVersions"]>[0]): void {
    void controller.loadVersions(pack)
  }

  function selectedVersionFor(packKey: string, latestVersion?: string): string {
    return selectedVersions[packKey] ?? latestVersion ?? ""
  }

  if (!snapshot.isOpen) return null

  return (
    <ControlPanelDialog
      title={t("nodes.title")}
      titleId="cp-nodes-manager-title"
      className={styles.managerDialog}
      initialFocusRef={searchRef}
      onClose={controller.close}
    >
      <div className={styles.managerBody}>
        <aside className={styles.sidebar} aria-label={t("nodes.filtersLabel")}>
          <nav className={styles.filterGroups} aria-label={t("nodes.filterExtensions")}>
            {FILTER_GROUPS.map((group) => (
              <section key={group.key} className={styles.filterGroup} aria-label={t(group.key)}>
                <h3 className={styles.sidebarLabel}>{t(group.key)}</h3>
                <div className={styles.filterList}>
                  {group.filters.map((item) => (
                    <Button
                      key={item.id}
                      className={styles.filterButton}
                      variant="ghost"
                      type="button"
                      aria-pressed={filter === item.id}
                      onClick={() => setFilter(item.id)}
                    >
                      <span>{t(item.key)}</span>
                      <span className={styles.filterCount}>{counts[item.id]}</span>
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </nav>
          <div className={styles.sidebarHelp}>{t("nodes.sidebarHelp")}</div>
        </aside>

        <main className={styles.main}>
          <div className={styles.toolbar} data-bulk={filter === "git" || filter === "updates"}>
            <label className={styles.searchField}>
              <span className={styles.visuallyHidden}>
                {t(workflowFilter ? "nodes.workflow.searchLabel" : "nodes.searchLabel")}
              </span>
              <input
                ref={searchRef}
                type="search"
                name="nodes-manager-search"
                autoComplete="off"
                placeholder={t(
                  workflowFilter ? "nodes.workflow.searchPlaceholder" : "nodes.searchPlaceholder",
                )}
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value)
                }}
              />
            </label>
            <label className={styles.sortField}>
              <span className={styles.visuallyHidden}>{t("nodes.sortLabel")}</span>
              <select
                name="nodes-manager-sort"
                value={sort}
                onChange={(event) => {
                  setSort(event.currentTarget.value as NodesManagerSort)
                }}
              >
                <option value="name">{t("nodes.sort.name")}</option>
                <option value="stars">{t("nodes.sort.stars")}</option>
                <option value="updated">{t("nodes.sort.updated")}</option>
                <option value="downloads">{t("nodes.sort.downloads")}</option>
              </select>
            </label>
            {(filter === "git" || filter === "updates") && (
              <Button
                type="button"
                variant="primary"
                busy={Boolean(snapshot.bulkOperation)}
                disabled={
                  snapshot.checking ||
                  snapshot.installedStatus !== "ready" ||
                  counts[filter] === 0 ||
                  taskOperations.some((operation) =>
                    ["starting", "pending", "unknown"].includes(operation.status),
                  )
                }
                onClick={() => void controller.submitAll(filter)}
              >
                {filter === "git" ? (
                  <HardDriveDownload size={24} aria-hidden="true" />
                ) : (
                  <Download size={24} aria-hidden="true" />
                )}
                {t(filter === "git" ? "nodes.fetchAll" : "nodes.updateAll")}
              </Button>
            )}
            <Button
              type="button"
              busy={snapshot.checking}
              busyLabel={t("nodes.refreshing")}
              onClick={() => void controller.refresh()}
            >
              <RefreshCw size={24} aria-hidden="true" />
              {t("nodes.refresh")}
            </Button>
          </div>

          {snapshot.catalogWarning && (
            <div className={styles.sourceNotice} role="status">
              <span>{snapshot.catalogWarning}</span>
            </div>
          )}
          {snapshot.catalogStatus === "loading" && (
            <p className={styles.notice} role="status" aria-live="polite">
              {t("nodes.catalogLoading")}
            </p>
          )}
          {snapshot.catalogStatus === "error" && (
            <div className={styles.errorNotice} role="alert">
              <span>
                {t("nodes.catalogReadFailed", {
                  error: snapshot.catalogErrorKey
                    ? t(snapshot.catalogErrorKey, snapshot.catalogErrorValues)
                    : (snapshot.catalogError ?? t("nodes.unknownError")),
                })}
              </span>
              <Button size="sm" type="button" onClick={() => void controller.refresh()}>
                {t("nodes.retry")}
              </Button>
            </div>
          )}
          {snapshot.installedStatus === "loading" && (
            <p className={styles.notice} role="status" aria-live="polite">
              {t("nodes.managerChecking")}
            </p>
          )}
          {snapshot.installedStatus === "error" && (
            <div className={styles.errorNotice} role="alert">
              <span>
                {t("nodes.managerUnavailable", {
                  detail: snapshot.installedErrorKey
                    ? ` ${t(snapshot.installedErrorKey, snapshot.installedErrorValues)}`
                    : snapshot.installedError
                      ? ` ${snapshot.installedError}`
                      : "",
                })}
              </span>
              <Button size="sm" type="button" onClick={() => void controller.refresh()}>
                {t("nodes.retry")}
              </Button>
            </div>
          )}
          {workflowFilter && snapshot.workflowStatus === "loading" && (
            <p className={styles.notice} role="status" aria-live="polite">
              {t("nodes.workflow.analyzing")}
            </p>
          )}
          {workflowFilter && snapshot.workflowStatus === "degraded" && (
            <div className={styles.sourceNotice} role="status">
              {snapshot.workflowError && (
                <span>{t("nodes.workflow.mappingFailed", { detail: snapshot.workflowError })}</span>
              )}
              {!snapshot.workflowAvailabilityKnown && (
                <span>{t("nodes.workflow.availabilityUnknown")}</span>
              )}
              {snapshot.workflowMappingIssueCount > 0 && (
                <span>
                  {t("nodes.workflow.mappingIssues", { count: snapshot.workflowMappingIssueCount })}
                </span>
              )}
            </div>
          )}
          {workflowFilter && workflowDiagnostics.length > 0 && (
            <section
              className={styles.workflowDiagnostics}
              aria-label={t("nodes.workflow.diagnostics")}
            >
              <h3>{t("nodes.workflow.diagnostics")}</h3>
              <p>
                {t("nodes.workflow.diagnosticSummary", {
                  unresolved: unresolvedDiagnosticCount,
                  unavailable: unavailableNodeCount,
                })}
              </p>
              <ul className={styles.workflowDiagnosticsList}>
                {workflowDiagnostics.map((diagnostic) => (
                  <li
                    key={`${diagnostic.kind}:${diagnostic.type}:${diagnostic.candidates?.join(",") ?? ""}`}
                    className={styles.workflowDiagnostic}
                  >
                    <strong translate="no">{diagnostic.type}</strong>
                    <span>
                      {t(`nodes.workflow.diagnostic.${diagnostic.kind}`, {
                        count: diagnostic.occurrences,
                      })}
                    </span>
                    {diagnostic.candidates && (
                      <span translate="no">{diagnostic.candidates.join(", ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {taskOperations.some((operation) => !dismissedTaskIds.has(operation.taskId)) && (
            <section className={styles.taskSummary} aria-label={t("nodes.recentResults")}>
              <div className={styles.taskSummaryHeader}>
                <h3>{t("nodes.recentResults")}</h3>
                <Button
                  size="sm"
                  type="button"
                  aria-label={t("nodes.closeTaskStatus")}
                  title={t("nodes.closeTaskStatus")}
                  onClick={() =>
                    setDismissedTaskIds(
                      new Set(taskOperations.map((operation) => operation.taskId)),
                    )
                  }
                >
                  <X size={16} aria-hidden="true" />
                </Button>
              </div>
              <div
                className={styles.taskSummaryList}
                tabIndex={0}
                role="region"
                aria-label={t("nodes.recentResults")}
              >
                {taskOperations.map((operation) => (
                  <div
                    key={operation.taskId}
                    className={styles.taskSummaryItem}
                    role={operation.status === "failed" ? "alert" : "status"}
                    aria-live="polite"
                  >
                    <strong>
                      {t("nodes.operationSeparator", {
                        pack: operation.pack.name,
                        operation:
                          operation.pack.source === "Git" && operation.operation === "update"
                            ? t("card.fetch")
                            : operationName(operation.operation),
                      })}
                    </strong>
                    <span>{operationStatusLabel(operation.status)}</span>
                    {operationMessage(operation) && <span>{operationMessage(operation)}</span>}
                    {operation.queueStartFailed && (
                      <Button
                        size="sm"
                        className={styles.taskSummaryRetryButton}
                        type="button"
                        disabled={
                          snapshot.installedStatus !== "ready" ||
                          operation.status === "starting" ||
                          operation.status === "pending"
                        }
                        onClick={() => void controller.retryQueueStart(operation.packKey)}
                      >
                        {t("nodes.retryQueue")}
                      </Button>
                    )}
                    {operation.restartRequired && <span>{t("nodes.restartRequired")}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className={styles.resultsHeader}>
            <h3>{t(FILTERS.find((item) => item.id === filter)?.key ?? "nodes.filter.all")}</h3>
            <span className={styles.resultCount} aria-live="polite">
              {t(
                filteredPacks.length === 1
                  ? "nodes.resultCount.singular"
                  : "nodes.resultCount.plural",
                { count: formattedCount },
              )}
            </span>
          </div>

          {(workflowFilter
            ? snapshot.workflowStatus !== "loading"
            : snapshot.catalogStatus !== "loading") &&
            filteredPacks.length === 0 && (
              <div className={styles.emptyState}>
                {workflowFilter
                  ? deferredSearch.trim()
                    ? t("nodes.empty.search")
                    : snapshot.workflowStatus === "unavailable"
                      ? t("nodes.workflow.noGraph")
                      : snapshot.workflowStatus === "degraded" &&
                          !snapshot.workflowAvailabilityKnown
                        ? t("nodes.workflow.availabilityUnknown")
                        : t(
                            filter === "workflow-missing"
                              ? "nodes.workflow.missingEmpty"
                              : "nodes.workflow.empty",
                          )
                  : snapshot.catalogStatus === "error" && snapshot.packs.length === 0
                    ? t("nodes.empty.noCatalog")
                    : search.trim()
                      ? t("nodes.empty.search")
                      : t("nodes.empty.filter")}
              </div>
            )}

          {packRows.length > 0 && (
            <div className={styles.virtualListViewport}>
              <Virtuoso
                ref={virtuosoRef}
                components={VIRTUOSO_COMPONENTS}
                data={packRows}
                style={{ height: "100%" }}
                scrollerRef={observeScroller}
                computeItemKey={(_index, row) => row.map((pack) => pack.key).join("\0")}
                itemContent={(_index, row) => (
                  <div
                    className={styles.cardGrid}
                    style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
                  >
                    {row.map((pack) => (
                      <NodesManagerCard
                        key={pack.key}
                        pack={pack}
                        operation={findOperationForPack(snapshot.operations, pack)}
                        versionState={snapshot.versions[pack.key]}
                        selectedVersion={selectedVersionFor(pack.key, pack.latestVersion?.version)}
                        actionsEnabled={
                          snapshot.installedStatus === "ready" && !snapshot.bulkOperation
                        }
                        onLoadVersions={() => ensureVersions(pack)}
                        onRetryVersions={() => retryVersions(pack)}
                        onSelectVersion={(version) =>
                          setSelectedVersions((current) => ({ ...current, [pack.key]: version }))
                        }
                        onSubmit={(operation, version) =>
                          void controller.submit(pack, operation, version)
                        }
                        onBrowse={() => void controller.browseLocalFolder(pack)}
                      />
                    ))}
                  </div>
                )}
              />
            </div>
          )}
        </main>
      </div>
    </ControlPanelDialog>
  )
}
