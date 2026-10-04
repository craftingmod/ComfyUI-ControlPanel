import { useDeferredValue, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { ControlPanelDialog } from "../components/controlPanelDialog.tsx"
import { NodesManagerCard } from "../components/NodesManagerCard.tsx"
import {
  filterAndSortManagedPacks,
  type NodesManagerFilter,
  type NodesManagerSort,
} from "../services/nodesManager.ts"
import type { NodesManagerController } from "../services/nodesManagerController.ts"
import { findOperationForPack } from "../services/nodesManagerController.ts"

import styles from "./nodesManager.module.css"

const PAGE_SIZE = 48

const FILTERS: { id: NodesManagerFilter; label: string }[] = [
  { id: "all", label: "All Extensions" },
  { id: "not-installed", label: "Not Installed" },
  { id: "installed", label: "All Installed" },
  { id: "updates", label: "Updates Available" },
  { id: "disabled", label: "Disabled" },
]

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
  const [page, setPage] = useState(1)
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({})
  const searchRef = useRef<HTMLInputElement>(null)
  const deferredSearch = useDeferredValue(search)

  const filteredPacks = useMemo(
    () => filterAndSortManagedPacks(snapshot.packs, filter, deferredSearch, sort),
    [snapshot.packs, filter, deferredSearch, sort],
  )
  const pageCount = Math.max(1, Math.ceil(filteredPacks.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pagePacks = filteredPacks.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
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

  function selectFilter(next: NodesManagerFilter): void {
    setFilter(next)
    setPage(1)
  }

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
              <button
                key={item.id}
                className={`${styles.filterButton} ${filter === item.id ? styles.filterSelected : ""}`}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => selectFilter(item.id)}
              >
                <span>{item.label}</span>
                <span className={styles.filterCount}>{counts[item.id]}</span>
              </button>
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
                  setPage(1)
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
                  setPage(1)
                }}
              >
                <option value="name">Sort: Name</option>
                <option value="stars">Sort: Most Stars</option>
                <option value="updated">Sort: Recently Updated</option>
                <option value="downloads">Sort: Most Downloads</option>
              </select>
            </label>
            <button
              className={styles.refreshButton}
              type="button"
              disabled={snapshot.checking}
              onClick={() => void controller.refresh()}
            >
              {snapshot.checking ? "Refreshing…" : "Refresh"}
            </button>
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
              <button
                className={styles.noticeRetryButton}
                type="button"
                onClick={() => void controller.refresh()}
              >
                Retry
              </button>
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
              <button
                className={styles.noticeRetryButton}
                type="button"
                onClick={() => void controller.refresh()}
              >
                Retry
              </button>
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
                    <button
                      className={styles.taskSummaryRetryButton}
                      type="button"
                      disabled={operation.status === "starting" || operation.status === "pending"}
                      onClick={() => void controller.retryQueueStart(operation.packKey)}
                    >
                      Retry Queue Start
                    </button>
                  )}
                  {operation.restartRequired && <span>Restart ComfyUI to load this change.</span>}
                </div>
              ))}
            </section>
          )}

          <div className={styles.resultsHeader}>
            <h3>{FILTERS.find((item) => item.id === filter)?.label}</h3>
            <span>
              {filteredPacks.length === 0
                ? "0 extensions"
                : `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filteredPacks.length)} of ${filteredPacks.length}`}
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

          {pagePacks.length > 0 && (
            <div className={styles.cardViewport} aria-label="Extensions">
              <div className={styles.cardGrid}>
                {pagePacks.map((pack) => (
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
            </div>
          )}

          <div className={styles.pagination}>
            <span>48 extensions per page</span>
            <div>
              <button
                className={styles.pageButton}
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </button>
              <span aria-live="polite">
                Page {currentPage} of {pageCount}
              </span>
              <button
                className={styles.pageButton}
                type="button"
                disabled={currentPage >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              >
                Next
              </button>
            </div>
          </div>
        </main>
      </div>
    </ControlPanelDialog>
  )
}
