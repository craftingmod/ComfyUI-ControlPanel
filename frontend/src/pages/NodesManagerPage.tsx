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
import {
  filterAndSortManagedPacks,
  type NodesManagerFilter,
  type NodesManagerSort,
} from "../services/nodesManager.ts"
import type { NodesManagerController } from "../services/nodesManagerController.ts"
import { findOperationForPack } from "../services/nodesManagerController.ts"

import styles from "./nodesManager.module.css"

const FILTERS: { id: NodesManagerFilter; label: string }[] = [
  { id: "all", label: "All Extensions" },
  { id: "not-installed", label: "Not Installed" },
  { id: "installed", label: "All Installed" },
  { id: "updates", label: "Updates Available" },
  { id: "disabled", label: "Disabled" },
]

const ExtensionScroller = forwardRef<HTMLDivElement, ScrollerProps>(
  function ExtensionScroller(props, ref) {
    return (
      <div
        {...props}
        ref={ref}
        className={styles.cardViewport}
        tabIndex={props.tabIndex ?? 0}
        role="region"
        aria-label="Extensions"
      />
    )
  },
)

const VIRTUOSO_COMPONENTS = { Scroller: ExtensionScroller } satisfies Components

type NodesManagerPageProps = {
  controller: NodesManagerController
}

export function NodesManagerPage({ controller }: NodesManagerPageProps) {
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
  const searchRef = useRef<HTMLInputElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const deferredSearch = useDeferredValue(search)

  const filteredPacks = useMemo(
    () => filterAndSortManagedPacks(snapshot.packs, filter, deferredSearch, sort),
    [snapshot.packs, filter, deferredSearch, sort],
  )
  const packRows = useMemo(() => {
    const rows: (typeof filteredPacks)[] = []
    for (let index = 0; index < filteredPacks.length; index += columnCount) {
      rows.push(filteredPacks.slice(index, index + columnCount))
    }
    return rows
  }, [columnCount, filteredPacks])
  const representedTaskIds = useMemo(() => {
    const taskIds = new Set<string>()
    for (const pack of snapshot.packs) {
      const operation = findOperationForPack(snapshot.operations, pack)
      if (operation) taskIds.add(operation.taskId)
    }
    return taskIds
  }, [snapshot.operations, snapshot.packs])
  const orphanedOperations = Object.values(snapshot.operations)
    .filter((operation) => !representedTaskIds.has(operation.taskId))
    .slice(-5)
    .reverse()
  const counts = useMemo(() => {
    const value: Record<NodesManagerFilter, number> = {
      all: snapshot.packs.length,
      "not-installed": 0,
      installed: 0,
      updates: 0,
      disabled: 0,
    }
    for (const pack of snapshot.packs) {
      if (pack.installed) value.installed += 1
      else value["not-installed"] += 1
      if (pack.updateAvailable) value.updates += 1
      if (pack.installed?.enabled === false) value.disabled += 1
    }
    return value
  }, [snapshot.packs])

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
      title="Nodes Manager"
      titleId="cp-nodes-manager-title"
      className={styles.managerDialog}
      initialFocusRef={searchRef}
      onClose={controller.close}
    >
      <div className={styles.managerBody}>
        <aside className={styles.sidebar} aria-label="Extension filters">
          <p className={styles.sidebarLabel}>Browse</p>
          <nav className={styles.filterList} aria-label="Filter extensions">
            {FILTERS.map((item) => (
              <Button
                key={item.id}
                className={styles.filterButton}
                variant="ghost"
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                <span>{item.label}</span>
                <span className={styles.filterCount}>{counts[item.id]}</span>
              </Button>
            ))}
          </nav>
          <div className={styles.sidebarHelp}>
            Install and update tasks run through ComfyUI-Manager. Restart ComfyUI to load node
            changes.
          </div>
        </aside>

        <main className={styles.main}>
          <div className={styles.toolbar}>
            <label className={styles.searchField}>
              <span className={styles.visuallyHidden}>Search extensions</span>
              <input
                ref={searchRef}
                type="search"
                name="nodes-manager-search"
                autoComplete="off"
                placeholder="Search name, ID, author, or description…"
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value)
                }}
              />
            </label>
            <label className={styles.sortField}>
              <span className={styles.visuallyHidden}>Sort extensions</span>
              <select
                name="nodes-manager-sort"
                value={sort}
                onChange={(event) => {
                  setSort(event.currentTarget.value as NodesManagerSort)
                }}
              >
                <option value="name">Sort: Name</option>
                <option value="stars">Sort: Most Stars</option>
                <option value="updated">Sort: Recently Updated</option>
                <option value="downloads">Sort: Most Downloads</option>
              </select>
            </label>
            <Button
              type="button"
              busy={snapshot.checking}
              busyLabel="Refreshing…"
              onClick={() => void controller.refresh()}
            >
              Refresh
            </Button>
          </div>

          {(snapshot.catalogSource || snapshot.catalogWarning) && (
            <div className={styles.sourceNotice} role="status">
              <strong>Catalog source: {snapshot.catalogSource ?? "Unknown"}</strong>
              {snapshot.catalogWarning && <span>{snapshot.catalogWarning}</span>}
            </div>
          )}
          {snapshot.catalogStatus === "loading" && (
            <p className={styles.notice} role="status" aria-live="polite">
              Loading the local extension catalog…
            </p>
          )}
          {snapshot.catalogStatus === "error" && (
            <div className={styles.errorNotice} role="alert">
              <span>
                Could not read the local extension catalog:{" "}
                {snapshot.catalogError ?? "Unknown error"}
              </span>
              <Button size="sm" type="button" onClick={() => void controller.refresh()}>
                Retry
              </Button>
            </div>
          )}
          {snapshot.installedStatus === "loading" && (
            <p className={styles.notice} role="status" aria-live="polite">
              Checking ComfyUI-Manager availability…
            </p>
          )}
          {snapshot.installedStatus === "error" && (
            <div className={styles.errorNotice} role="alert">
              <span>
                ComfyUI-Manager installed-node data is unavailable. Actions are disabled.
                {snapshot.installedError ? ` ${snapshot.installedError}` : ""}
              </span>
              <Button size="sm" type="button" onClick={() => void controller.refresh()}>
                Retry
              </Button>
            </div>
          )}
          {snapshot.installedStatus === "ready" && (
            <p className={styles.managerReady} role="status">
              ComfyUI-Manager is available. Changes require a ComfyUI restart.
            </p>
          )}

          {orphanedOperations.length > 0 && (
            <section className={styles.taskSummary} aria-label="Recent Manager results">
              <h3>Recent Manager results</h3>
              {orphanedOperations.map((operation) => (
                <div
                  key={operation.taskId}
                  className={styles.taskSummaryItem}
                  role="status"
                  aria-live="polite"
                >
                  <strong>
                    {operation.pack.name} · {operation.operation}
                  </strong>
                  <span>
                    {operation.status === "unknown" ? "Outcome unknown" : operation.status}
                  </span>
                  {operation.message && <span>{operation.message}</span>}
                  {operation.queueStartFailed && (
                    <Button
                      size="sm"
                      className={styles.taskSummaryRetryButton}
                      type="button"
                      disabled={operation.status === "starting" || operation.status === "pending"}
                      onClick={() => void controller.retryQueueStart(operation.packKey)}
                    >
                      Retry Queue Start
                    </Button>
                  )}
                  {operation.restartRequired && <span>Restart ComfyUI to load this change.</span>}
                </div>
              ))}
            </section>
          )}

          <div className={styles.resultsHeader}>
            <h3>{FILTERS.find((item) => item.id === filter)?.label}</h3>
            <span className={styles.resultCount} aria-live="polite">
              {filteredPacks.length.toLocaleString()}{" "}
              {filteredPacks.length === 1 ? "extension" : "extensions"}
            </span>
          </div>

          {snapshot.catalogStatus !== "loading" && filteredPacks.length === 0 && (
            <div className={styles.emptyState}>
              {snapshot.catalogStatus === "error" && snapshot.packs.length === 0
                ? "No cached catalog is available. Check the ControlPanel Registry cache and retry."
                : search.trim()
                  ? "No extensions match this search."
                  : "No extensions match this filter."}
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
                        actionsEnabled={snapshot.installedStatus === "ready"}
                        onLoadVersions={() => ensureVersions(pack)}
                        onRetryVersions={() => retryVersions(pack)}
                        onSelectVersion={(version) =>
                          setSelectedVersions((current) => ({ ...current, [pack.key]: version }))
                        }
                        onSubmit={(operation, version) =>
                          void controller.submit(pack, operation, version)
                        }
                        onRetryQueueStart={() => {
                          const operation = findOperationForPack(snapshot.operations, pack)
                          if (operation) void controller.retryQueueStart(operation.packKey)
                        }}
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
