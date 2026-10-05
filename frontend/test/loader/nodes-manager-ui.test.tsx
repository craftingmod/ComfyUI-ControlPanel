import { expect, it, vi } from "bun:test"

import { act } from "react"
import { createRoot } from "react-dom/client"
import { VirtuosoMockContext } from "react-virtuoso"

import type {
  ControlPanelActions,
  ControlPanelViewState,
} from "../../src/components/controlPanelTypes.ts"
import { ControlPanelPage } from "../../src/pages/ControlPanelPage.tsx"
import { NodesManagerPage } from "../../src/pages/NodesManagerPage.tsx"
import type { ManagedPack, RegistryVersion } from "../../src/services/nodesManager.ts"
import type {
  NodesManagerOperationState,
  NodesManagerController,
  NodesManagerSnapshot,
} from "../../src/services/nodesManagerController.ts"

const MOCK_LIST_ITEM_HEIGHT = 420
const MOCK_LIST_VIEWPORT_HEIGHT = 680

function managedPack(id: string, changes: Partial<ManagedPack> = {}): ManagedPack {
  return {
    key: id,
    id,
    name: `Pack ${id}`,
    description: `Description for ${id}`,
    author: "Example Author",
    repository: `https://github.com/example/${id}`,
    stars: 5,
    downloads: 100,
    updatedAt: "2026-09-01T00:00:00Z",
    latestVersion: { version: "1.0.0", status: "Active" },
    managerNodeId: id,
    isUnknown: false,
    source: "Registry",
    updateAvailable: false,
    ...changes,
  }
}

function managerSnapshot(
  packs: ManagedPack[],
  changes: Partial<NodesManagerSnapshot> = {},
): NodesManagerSnapshot {
  return {
    isOpen: true,
    catalogStatus: "ready",
    installedStatus: "ready",
    installed: [],
    packs,
    workflowStatus: "ready",
    workflowAvailabilityKnown: true,
    workflowPacks: [],
    workflowMissingPacks: [],
    workflowDiagnostics: [],
    workflowMappingIssueCount: 0,
    operations: {},
    versions: {},
    checking: false,
    ...changes,
  }
}

function createManager(initial: NodesManagerSnapshot) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const update = (patch: Partial<NodesManagerSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const controller: NodesManagerController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open: vi.fn(async () => update({ isOpen: true })),
    close: vi.fn(() => update({ isOpen: false })),
    refresh: vi.fn(async () => undefined),
    loadVersions: vi.fn(async (pack) => {
      const values: RegistryVersion[] = [
        { version: "1.0.0", status: "Active" },
        { version: "0.9.0", status: "Flagged", status_reason: "Known security issue" },
      ]
      update({ versions: { ...snapshot.versions, [pack.key]: { loading: false, values } } })
    }),
    submit: vi.fn(async () => false),
    submitAll: vi.fn(async () => undefined),
    browseLocalFolder: vi.fn(async () => undefined),
    retryQueueStart: vi.fn(async () => false),
  }
  return { controller, update }
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  )
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}

function findButtonContaining(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.includes(text),
  )
  if (!button) throw new Error(`Missing button containing: ${text}`)
  return button
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(
    new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  )
}

function dispatchKey(element: HTMLElement, key: string): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function mountNodesManager(
  snapshot: NodesManagerSnapshot,
  actions: { onBackupInstalledNodes?: () => void; onChooseNodeRestoreFile?: () => void } = {},
) {
  const manager = createManager(snapshot)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <VirtuosoMockContext.Provider
        value={{ itemHeight: MOCK_LIST_ITEM_HEIGHT, viewportHeight: MOCK_LIST_VIEWPORT_HEIGHT }}
      >
        <NodesManagerPage
          controller={manager.controller}
          onBackupInstalledNodes={actions.onBackupInstalledNodes ?? (() => undefined)}
          onChooseNodeRestoreFile={actions.onChooseNodeRestoreFile ?? (() => undefined)}
        />
      </VirtuosoMockContext.Provider>,
    ),
  )
  return {
    ...manager,
    destroy: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

it("shows Backup and Restore only in All Installed and reuses the provided actions", async () => {
  const onBackupInstalledNodes = vi.fn()
  const onChooseNodeRestoreFile = vi.fn()
  const mounted = await mountNodesManager(
    managerSnapshot([
      managedPack("installed-pack", {
        installed: { key: "installed-pack", version: "1.0.0", enabled: true },
      }),
    ]),
    { onBackupInstalledNodes, onChooseNodeRestoreFile },
  )

  try {
    expect(() => findButton("Backup")).toThrow("Missing button: Backup")
    await act(async () => findButtonContaining("All Installed").click())

    await act(async () => findButton("Backup").click())
    await act(async () => findButton("Restore").click())

    expect(onBackupInstalledNodes).toHaveBeenCalledTimes(1)
    expect(onChooseNodeRestoreFile).toHaveBeenCalledTimes(1)
    await act(async () => findButtonContaining("All Extensions").click())
    expect(() => findButton("Backup")).toThrow("Missing button: Backup")
  } finally {
    await mounted.destroy()
  }
})

function scrollVirtualListTo(top: number, itemCount: number): HTMLElement {
  const scroller = document.querySelector<HTMLElement>("[data-virtuoso-scroller]")
  if (!scroller) throw new Error("Missing virtualized Extensions scroller")

  let scrollTop = scroller.scrollTop
  Object.defineProperties(scroller, {
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => itemCount * MOCK_LIST_ITEM_HEIGHT,
    },
    clientHeight: {
      configurable: true,
      value: MOCK_LIST_VIEWPORT_HEIGHT,
    },
    offsetHeight: {
      configurable: true,
      value: MOCK_LIST_VIEWPORT_HEIGHT,
    },
    scrollTo: {
      configurable: true,
      value: (options: ScrollToOptions) => {
        scrollTop = options.top ?? scrollTop
        scroller.dispatchEvent(new Event("scroll"))
      },
    },
  })
  scrollTop = top
  scroller.dispatchEvent(new Event("scroll"))
  return scroller
}

async function settleVirtualScroll(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

it("opens a local card's folder from its right-side Browse button", async () => {
  const pack = managedPack("local", {
    source: "Local folder",
    readOnly: true,
    installed: { key: "V:/custom_nodes/local", local: true, enabled: true },
  })
  const mounted = await mountNodesManager(managerSnapshot([pack]))
  try {
    await act(async () => findButtonContaining("Local / Unmanaged").click())
    const browse = document.querySelector<HTMLButtonElement>('[data-action="browse"]')!
    expect(browse.textContent?.trim()).toBe("Browse")
    expect(browse.disabled).toBe(false)
    await act(async () => browse.click())
    expect(mounted.controller.browseLocalFolder).toHaveBeenCalledWith(pack)
  } finally {
    await mounted.destroy()
  }
})

it("shows bulk actions only in their toolbar categories and disables unavailable actions", async () => {
  const mounted = await mountNodesManager(
    managerSnapshot([
      managedPack("git", { source: "Git", installed: { key: "git", enabled: true } }),
      managedPack("update", { updateAvailable: true, installed: { key: "update", enabled: true } }),
    ]),
  )
  try {
    expect(document.querySelector('[data-bulk="true"]')).toBeNull()
    await act(async () => findButtonContaining("Git-installed").click())
    const fetchAll = findButton("Fetch all")
    expect(fetchAll.closest<HTMLElement>("[data-bulk]")?.dataset.bulk).toBe("true")
    await act(async () => fetchAll.click())
    expect(mounted.controller.submitAll).toHaveBeenCalledWith("git")
    await act(async () => findButtonContaining("Updates Available").click())
    await act(async () => findButton("Update All").click())
    expect(mounted.controller.submitAll).toHaveBeenCalledWith("updates")
    await act(async () => mounted.update({ bulkOperation: "updates" }))
    expect(findButton("Update All").disabled).toBe(true)
    await act(async () => mounted.update({ bulkOperation: undefined, installedStatus: "error" }))
    expect(findButton("Update All").disabled).toBe(true)
    await act(async () => mounted.update({ installedStatus: "ready", packs: [] }))
    expect(findButton("Update All").disabled).toBe(true)
    await act(async () => findButtonContaining("Local / Unmanaged").click())
    expect(document.querySelector('[data-bulk="true"]')).toBeNull()
  } finally {
    await mounted.destroy()
  }
})

it("shows Install missing only in its workflow category and disables it without an installable Registry target", async () => {
  const registryPack = managedPack("missing-registry")
  const readOnlyPack = managedPack("https://github.com/example/read-only", {
    id: "read-only",
    source: "Unknown",
    readOnly: true,
    isUnknown: true,
  })
  const mounted = await mountNodesManager(
    managerSnapshot([registryPack, readOnlyPack], {
      workflowPacks: [registryPack, readOnlyPack],
      workflowMissingPacks: [readOnlyPack, registryPack],
    }),
  )
  try {
    expect(document.querySelector('[data-bulk="true"]')).toBeNull()
    await act(async () => findButtonContaining("Missing").click())
    const installMissing = findButton("Install missing")
    expect(installMissing.closest<HTMLElement>("[data-bulk]")?.dataset.bulk).toBe("true")
    expect(installMissing.disabled).toBe(false)

    await act(async () =>
      setValue(
        document.querySelector<HTMLInputElement>('input[name="nodes-manager-search"]')!,
        "no matching workflow pack",
      ),
    )
    expect(installMissing.disabled).toBe(false)
    await act(async () => installMissing.click())
    expect(mounted.controller.submitAll).toHaveBeenCalledWith("workflow-missing", {})

    await act(async () => mounted.update({ bulkOperation: "workflow-missing" }))
    expect(findButton("Install missing").disabled).toBe(true)
    await act(async () =>
      mounted.update({ bulkOperation: undefined, workflowAvailabilityKnown: false }),
    )
    expect(findButton("Install missing").disabled).toBe(true)
    await act(async () =>
      mounted.update({ workflowAvailabilityKnown: true, installedStatus: "error" }),
    )
    expect(findButton("Install missing").disabled).toBe(true)
    await act(async () =>
      mounted.update({ installedStatus: "ready", workflowMissingPacks: [readOnlyPack] }),
    )
    expect(findButton("Install missing").disabled).toBe(true)
  } finally {
    await mounted.destroy()
  }
})

it("shows workflow pack categories and reports node diagnostics separately from extension counts", async () => {
  const registryPack = managedPack("registry-pack")
  const readOnlyPack = managedPack("https://github.com/example/unregistered-pack", {
    id: "unregistered-pack",
    name: "Unregistered Pack",
    repository: "https://github.com/example/unregistered-pack",
    source: "Unknown",
    readOnly: true,
    isUnknown: true,
  })
  const mounted = await mountNodesManager(
    managerSnapshot([registryPack, readOnlyPack], {
      workflowPacks: [registryPack, readOnlyPack],
      workflowMissingPacks: [registryPack],
      workflowDiagnostics: [{ type: "UnknownNode", kind: "unresolved", occurrences: 2 }],
    }),
  )

  try {
    await act(async () => findButtonContaining("In Workflow").click())
    expect(document.querySelectorAll("article")).toHaveLength(2)
    expect(document.body.textContent).toContain("2 extensions")
    expect(document.body.textContent).toContain("2 unresolved or ambiguous node entries")

    await act(async () => findButtonContaining("Missing").click())
    expect(document.querySelectorAll("article")).toHaveLength(1)
    expect(document.body.textContent).not.toContain("Unregistered Pack")
    expect(document.body.textContent).toContain("Pack registry-pack")
    expect(document.querySelector<HTMLButtonElement>('[data-action="install"]')?.disabled).toBe(
      false,
    )
  } finally {
    await mounted.destroy()
  }
})

it("keeps latest as the install default and reveals version choices after fetch", async () => {
  const pack = managedPack("example-pack")
  const mounted = await mountNodesManager(managerSnapshot([pack]))
  const firstRequest = deferred<RegistryVersion[] | Error>()
  const retryRequest = deferred<RegistryVersion[] | Error>()
  const requestedPacks: ManagedPack[] = []
  let requestCount = 0
  mounted.controller.loadVersions = async (targetPack) => {
    requestedPacks.push(targetPack)
    requestCount += 1
    mounted.update({
      versions: {
        ...mounted.controller.getSnapshot().versions,
        [targetPack.key]: { loading: true },
      },
    })
    const result = await (requestCount === 1 ? firstRequest.promise : retryRequest.promise)
    mounted.update({
      versions: {
        ...mounted.controller.getSnapshot().versions,
        [targetPack.key]:
          result instanceof Error
            ? { loading: false, error: result.message }
            : { loading: false, values: result },
      },
    })
  }
  try {
    expect(document.querySelector('select[name="version-example-pack"]')).toBeNull()
    await act(async () => findButton("Install").click())
    expect(mounted.controller.submit).toHaveBeenCalledWith(pack, "install", "1.0.0")

    const chooseVersion = document.querySelector<HTMLButtonElement>('[data-action="load-version"]')!
    await act(async () => chooseVersion.focus())
    expect(requestCount).toBe(0)
    await act(async () => chooseVersion.click())
    expect(requestedPacks).toEqual([pack])
    expect(requestCount).toBe(1)
    expect(chooseVersion.disabled).toBe(true)
    expect(chooseVersion.getAttribute("aria-busy")).toBe("true")
    expect(document.body.textContent?.match(/Loading versions…/g)).toHaveLength(1)
    expect(
      document.querySelector('article a[href="https://github.com/example/example-pack"]'),
    ).not.toBeNull()
    expect(document.querySelector('select[name="version-example-pack"]')).toBeNull()

    await act(async () => {
      firstRequest.resolve(new Error("Registry temporarily unavailable."))
      await firstRequest.promise
    })
    expect(document.querySelector('select[name="version-example-pack"]')).toBeNull()
    expect(document.body.textContent).toContain(
      "Could not load versions: Registry temporarily unavailable.",
    )
    expect(chooseVersion.disabled).toBe(false)

    await act(async () => findButton("Retry").click())
    expect(requestedPacks).toEqual([pack, pack])
    expect(requestCount).toBe(2)
    expect(document.querySelector('select[name="version-example-pack"]')).toBeNull()
    expect(chooseVersion.disabled).toBe(true)
    expect(document.body.textContent?.match(/Loading versions…/g)).toHaveLength(1)

    await act(async () => {
      retryRequest.resolve([
        { version: "1.0.0", status: "Active" },
        { version: "0.9.0", status: "Flagged", status_reason: "Known security issue" },
        { version: "0.8.0", status: "NodeVersionStatusPending" },
        { version: "0.7.0", status: "NodeVersionStatusBanned" },
      ])
      await retryRequest.promise
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="cancel-version"]')!.click()
    })
    expect(document.querySelector('select[name="version-example-pack"]')).toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-action="load-version"]')!.click()
    })
    expect(requestCount).toBe(2)
    const selector = document.querySelector<HTMLSelectElement>(
      'select[name="version-example-pack"]',
    )!

    expect(document.querySelector('[data-action="load-version"]')).toBeNull()
    expect(Array.from(selector.options).map((option) => option.textContent)).toEqual([
      "Choose a version…",
      "1.0.0",
      "0.9.0 (Flagged)",
      "0.8.0 (Pending)",
    ])

    await act(async () => setValue(selector, "0.9.0"))
    expect(selector.selectedOptions[0]?.textContent).toBe("0.9.0 (Flagged)")
    expect(document.body.textContent).not.toContain("Known security issue")
    await act(async () => findButton("Install").click())

    expect(mounted.controller.submit).toHaveBeenCalledWith(pack, "install", "0.9.0")
  } finally {
    await mounted.destroy()
  }
})

it("filters Git nodes with counts and search, including disabled Git installs", async () => {
  const packs = [
    managedPack("registry-pack"),
    managedPack("git-enabled", {
      source: "Git",
      installed: { key: "git-enabled", version: "abc123", enabled: true },
    }),
    managedPack("git-disabled", {
      source: "Git",
      installed: { key: "git-disabled", version: "def456", enabled: false },
    }),
    managedPack("unknown-pack", { source: "Unknown" }),
  ]
  const mounted = await mountNodesManager(managerSnapshot(packs))
  try {
    const gitFilter = findButtonContaining("Git-installed")
    expect(gitFilter.textContent).toContain("2")
    await act(async () => gitFilter.click())
    expect(gitFilter.getAttribute("aria-pressed")).toBe("true")
    expect(document.querySelectorAll("article")).toHaveLength(2)
    expect(document.body.textContent).toContain("Pack git-enabled")
    expect(document.body.textContent).toContain("Pack git-disabled")
    expect(document.body.textContent).not.toContain("Pack registry-pack")
    expect(document.body.textContent).not.toContain("Pack unknown-pack")
    await act(async () =>
      setValue(
        document.querySelector<HTMLInputElement>('input[name="nodes-manager-search"]')!,
        "git-disabled",
      ),
    )
    expect(document.querySelectorAll("article")).toHaveLength(1)
    expect(document.body.textContent).toContain("Pack git-disabled")
    expect(gitFilter.textContent).toContain("2")
  } finally {
    await mounted.destroy()
  }
})

it("warns on the installed Flagged version, independent of the latest version's status", async () => {
  const flagged = { version: "0.9.0", status: "NodeVersionStatusFlagged" }
  for (const [installedVersion, latestVersion, latestFlaggedVersion, expected] of [
    ["0.9.0", { version: "1.0.0", status: "Active" }, flagged, "warning"],
    ["0.9.0", flagged, undefined, "warning"],
    ["1.0.0", flagged, flagged, "secondary"],
    [undefined, flagged, flagged, "secondary"],
  ] as const) {
    const pack = managedPack("pack", {
      installed: installedVersion
        ? { key: "pack", version: installedVersion, enabled: true }
        : undefined,
      latestVersion,
      latestFlaggedVersion,
    })
    const mounted = await mountNodesManager(managerSnapshot([pack]))
    try {
      expect(
        document.querySelector<HTMLButtonElement>('[data-action="load-version"]')?.dataset.variant,
      ).toBe(expected)
    } finally {
      await mounted.destroy()
    }
  }
})

it("requires the Flagged latest setting for default updates while allowing explicit version selection", async () => {
  for (const enabled of [false, true]) {
    const pack = managedPack("example-pack", {
      latestVersion: { version: "0.9.0", status: "Flagged" },
      useFlaggedVersionAsLatest: enabled,
      installed: { key: "example-pack", version: "0.8.0", enabled: true },
    })
    const mounted = await mountNodesManager(managerSnapshot([pack]))
    try {
      const update = document.querySelector<HTMLButtonElement>('[data-action="update"]')!
      expect(update.disabled).toBe(!enabled)
      if (enabled) {
        await act(async () => update.click())
        expect(mounted.controller.submit).toHaveBeenCalledWith(pack, "update", undefined)
      }
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-action="load-version"]')!.click(),
      )
      const selector = document.querySelector<HTMLSelectElement>(
        'select[name="version-example-pack"]',
      )!
      await act(async () => setValue(selector, "0.9.0"))
      expect(update.disabled).toBe(false)
      await act(async () => update.click())
      expect(mounted.controller.submit).toHaveBeenLastCalledWith(pack, "switch", "0.9.0")
    } finally {
      await mounted.destroy()
    }
  }
})

it("uses the update button for the selected version and restores latest update on cancel", async () => {
  const pack = managedPack("example-pack", {
    installed: { key: "example-pack", version: "0.8.0", enabled: true },
  })
  const mounted = await mountNodesManager(managerSnapshot([pack]))
  try {
    const updateButton = document.querySelector<HTMLButtonElement>('[data-action="update"]')!
    expect(updateButton.textContent?.trim()).toBe("1.0.0")
    await act(async () => updateButton.click())
    expect(mounted.controller.submit).toHaveBeenLastCalledWith(pack, "update", undefined)

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-action="load-version"]')!.click(),
    )
    expect(document.querySelector('[data-action="switch-version"]')).toBeNull()
    const selector = document.querySelector<HTMLSelectElement>(
      'select[name="version-example-pack"]',
    )!
    await act(async () => setValue(selector, "0.9.0"))
    expect(updateButton.textContent?.trim()).toBe("0.9.0")
    expect(updateButton.dataset.flagged).toBe("true")
    expect(updateButton.querySelector("svg.lucide-download")).not.toBeNull()
    await act(async () => updateButton.click())
    expect(mounted.controller.submit).toHaveBeenLastCalledWith(pack, "switch", "0.9.0")

    await act(async () => setValue(selector, "1.0.0"))
    expect(updateButton.dataset.flagged).toBe("false")
    await act(async () => setValue(selector, ""))
    expect(updateButton.disabled).toBe(true)
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-action="cancel-version"]')!.click(),
    )
    expect(updateButton.disabled).toBe(false)
    expect(updateButton.textContent?.trim()).toBe("1.0.0")
    await act(async () => updateButton.click())
    expect(mounted.controller.submit).toHaveBeenLastCalledWith(pack, "update", undefined)
  } finally {
    await mounted.destroy()
  }
})

it("keeps task details and queue retry outside cards for represented and removed packs", async () => {
  const pack = managedPack("example-pack", {
    installed: { key: "example-pack", version: "0.8.0", enabled: true },
  })
  const operation: NodesManagerOperationState = {
    packKey: pack.key,
    pack,
    taskId: "task-example",
    clientId: "test-client",
    operation: "update",
    status: "pending",
    message: "Installing dependencies for example-pack.",
  }
  const mounted = await mountNodesManager(
    managerSnapshot([pack], { operations: { [pack.key]: operation } }),
  )
  try {
    const summary = document.querySelector('section[aria-label="Manager task status"]')!
    const card = document.querySelector("article")!
    expect(summary.textContent).toContain(operation.message!)
    expect(card.textContent).not.toContain(operation.message!)
    expect(card.querySelector('[data-action="update"]')?.getAttribute("aria-busy")).toBe("true")
    expect(card.querySelector("svg.lucide-loader-circle")).not.toBeNull()

    await act(async () =>
      mounted.update({
        operations: {
          [pack.key]: {
            ...operation,
            status: "failed",
            message: "Queue start failed.",
            queueStartFailed: true,
            restartRequired: true,
          },
        },
      }),
    )
    expect(summary.textContent).toContain("Queue start failed.")
    expect(summary.textContent).toContain("Restart ComfyUI to load this change.")
    expect(card.textContent).not.toContain("Queue start failed.")
    expect(card.querySelector("svg.lucide-circle-alert")).not.toBeNull()
    const retry = findButton("Retry Queue Start")
    expect(retry.closest("article")).toBeNull()
    await act(async () => retry.click())
    expect(mounted.controller.retryQueueStart).toHaveBeenCalledWith(pack.key)
    await act(async () => mounted.update({ packs: [] }))
    expect(document.querySelector("article")).toBeNull()
    expect(summary.textContent).toContain("Queue start failed.")
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Close task status"]')!.click(),
    )
    expect(document.querySelector('section[aria-label="Manager task status"]')).toBeNull()
    await act(async () =>
      mounted.update({ operations: { [pack.key]: { ...operation, status: "succeeded" } } }),
    )
    expect(document.querySelector('section[aria-label="Manager task status"]')).toBeNull()
    await act(async () =>
      mounted.update({ operations: { [pack.key]: { ...operation, taskId: "new-task" } } }),
    )
    expect(document.querySelector('section[aria-label="Manager task status"]')).not.toBeNull()
  } finally {
    await mounted.destroy()
  }
})

it("closes the version panel when switching categories or reopening the manager", async () => {
  const mounted = await mountNodesManager(managerSnapshot([managedPack("example-pack")]))
  const selector = 'select[name="version-example-pack"]'
  const openVersion = async () => {
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-action="load-version"]')!.click(),
    )
    expect(document.querySelector(selector)).not.toBeNull()
  }
  try {
    await openVersion()
    await act(async () => findButtonContaining("Not Installed").click())
    expect(document.querySelector(selector)).toBeNull()
    await openVersion()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-action="cancel-version"]')!.click(),
    )
    await act(async () => findButtonContaining("All Extensions").click())
    await act(async () => findButtonContaining("Not Installed").click())
    expect(document.querySelector(selector)).toBeNull()
    await openVersion()
    await act(async () => mounted.update({ isOpen: false }))
    await act(async () => mounted.update({ isOpen: true }))
    expect(document.querySelector(selector)).toBeNull()
    expect(mounted.controller.loadVersions).toHaveBeenCalledTimes(1)
  } finally {
    await mounted.destroy()
  }
})

it("virtually scrolls past 48 results and keeps selection with the version panel closed on remount", async () => {
  const packs = Array.from({ length: 60 }, (_, index) =>
    managedPack(`pack-${index + 1}`, { downloads: 1_000 - index }),
  )
  const mounted = await mountNodesManager(managerSnapshot(packs))
  try {
    expect(
      document.querySelector<HTMLSelectElement>('select[name="nodes-manager-sort"]')?.value,
    ).toBe("downloads")
    expect(document.body.textContent).toContain("60 extensions")
    expect(document.body.textContent).not.toContain("Previous")
    expect(document.body.textContent).not.toContain("Next")

    const scroller = document.querySelector<HTMLElement>("[data-virtuoso-scroller]")!
    expect(scroller.tabIndex).toBe(0)
    expect(scroller.getAttribute("aria-label")).toBe("Extensions")
    expect(document.querySelectorAll("article").length).toBeLessThan(packs.length)

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-action="load-version"]')!.click(),
    )
    const firstPackVersions = document.querySelector<HTMLSelectElement>(
      'select[name="version-pack-1"]',
    )!
    await act(async () => setValue(firstPackVersions, "0.9.0"))

    await act(async () => {
      scrollVirtualListTo((packs.length - 1) * MOCK_LIST_ITEM_HEIGHT, packs.length)
      await settleVirtualScroll()
    })
    expect(document.body.textContent).toContain("Pack pack-60")
    expect(document.querySelector('select[name="version-pack-1"]')).toBeNull()
    const endScrollTop = scroller.scrollTop

    const loadedVersions: RegistryVersion[] = [
      { version: "1.0.0", status: "Active" },
      { version: "0.9.0", status: "Flagged", status_reason: "Known security issue" },
    ]
    await act(async () => {
      mounted.update({
        versions: {
          ...mounted.controller.getSnapshot().versions,
          "pack-60": { loading: false, values: loadedVersions },
        },
      })
      await settleVirtualScroll()
    })
    expect(scroller.scrollTop).toBe(endScrollTop)
    expect(document.body.textContent).toContain("Pack pack-60")

    await act(async () => {
      scrollVirtualListTo(0, packs.length)
      await settleVirtualScroll()
    })
    expect(document.querySelector('select[name="version-pack-1"]')).toBeNull()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-action="load-version"]')!.click(),
    )
    expect(document.querySelector<HTMLSelectElement>('select[name="version-pack-1"]')?.value).toBe(
      "0.9.0",
    )

    await act(async () => {
      scrollVirtualListTo((packs.length - 1) * MOCK_LIST_ITEM_HEIGHT, packs.length)
      await settleVirtualScroll()
    })
    await act(async () => {
      findButtonContaining("Not Installed").click()
      await settleVirtualScroll()
    })
    expect(scroller.scrollTop).toBe(0)
    expect(document.body.textContent).toContain("Pack pack-1")

    await act(async () => {
      scrollVirtualListTo((packs.length - 1) * MOCK_LIST_ITEM_HEIGHT, packs.length)
      await settleVirtualScroll()
    })
    const sort = document.querySelector<HTMLSelectElement>('select[name="nodes-manager-sort"]')!
    await act(async () => {
      setValue(sort, "name")
      await settleVirtualScroll()
    })
    expect(scroller.scrollTop).toBe(0)
    expect(document.body.textContent).toContain("Pack pack-1")

    await act(async () => {
      scrollVirtualListTo((packs.length - 1) * MOCK_LIST_ITEM_HEIGHT, packs.length)
      await settleVirtualScroll()
    })
    const search = document.querySelector<HTMLInputElement>('input[name="nodes-manager-search"]')!
    await act(async () => {
      setValue(search, "pack-60")
      await settleVirtualScroll()
    })
    expect(scroller.scrollTop).toBe(0)
    expect(document.querySelectorAll("article")).toHaveLength(1)
    expect(document.body.textContent).toContain("Pack pack-60")

    await act(async () => {
      setValue(search, "no-such-extension")
      await settleVirtualScroll()
    })
    expect(document.querySelectorAll("article")).toHaveLength(0)
    expect(document.body.textContent).toContain("No extensions match this search.")
  } finally {
    await mounted.destroy()
  }
})

it("disables mutation buttons when Manager installed-node data is unavailable", async () => {
  const pack = managedPack("offline-pack")
  const mounted = await mountNodesManager(
    managerSnapshot([pack], {
      installedStatus: "error",
      installedError: "Manager v2 endpoint is unavailable.",
    }),
  )
  try {
    expect(document.body.textContent).toContain("Actions are disabled")
    expect(findButton("Install").disabled).toBe(true)
    expect(mounted.controller.submit).not.toHaveBeenCalled()
  } finally {
    await mounted.destroy()
  }
})

it("keeps an orphaned accepted task visible and retries only Queue Start", async () => {
  const pack = managedPack("removed-git-pack", {
    source: "Git",
    installed: {
      key: "removed-git-pack",
      auxId: "https://github.com/example/removed-git-pack",
      enabled: true,
    },
  })
  const operation: NodesManagerOperationState = {
    packKey: pack.key,
    pack,
    taskId: "accepted-task",
    clientId: "test-client",
    operation: "uninstall",
    status: "unknown",
    message: "Task was accepted, but the queue did not start.",
    accepted: true,
    queueStartFailed: true,
  }
  const mounted = await mountNodesManager(
    managerSnapshot([], { operations: { [pack.key]: operation } }),
  )
  try {
    expect(document.body.textContent).toContain("Pack removed-git-pack · Uninstall")
    expect(document.body.textContent).toContain("Outcome unknown")
    await act(async () => findButton("Retry Queue Start").click())
    expect(mounted.controller.retryQueueStart).toHaveBeenCalledWith(pack.key)
  } finally {
    await mounted.destroy()
  }
})

it("keeps the parent dialog inert while open, closes on Escape, and reopens with the Panel", async () => {
  const manager = createManager(managerSnapshot([], { isOpen: false }))
  let panelView: ControlPanelViewState = {
    isOpen: true,
    log: "",
    managerCacheControlsEnabled: false,
    managerCacheStatus: "panel.managerCacheEnabled",
    updateCheckOutput: "",
  }
  const panelListeners = new Set<() => void>()
  const updatePanel = (patch: Partial<ControlPanelViewState>) => {
    panelView = { ...panelView, ...patch }
    for (const listener of panelListeners) listener()
  }
  const actions = {
    nodesManager: manager.controller,
    getSnapshot: () => panelView,
    subscribe: (listener: () => void) => {
      panelListeners.add(listener)
      return () => panelListeners.delete(listener)
    },
    close: vi.fn(() => {
      manager.controller.close()
      updatePanel({ isOpen: false })
    }),
    clearLog: vi.fn(),
    toast: vi.fn(),
    runOperation: vi.fn(async () => undefined),
    startUpdateJob: vi.fn(async () => undefined),
    refreshPanelStatus: vi.fn(async () => undefined),
    showStatusJson: vi.fn(async () => undefined),
    repairMetadata: vi.fn(async () => undefined),
    listSnapshots: vi.fn(async () => []),
    restoreSnapshot: vi.fn(async () => undefined),
    backupInstalledNodes: vi.fn(async () => undefined),
    restoreNodesFromFile: vi.fn(async () => undefined),
    showEnvironment: vi.fn(async () => ({})),
    showUpdateCheck: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    rebuildManagerCache: vi.fn(async () => undefined),
  } as unknown as ControlPanelActions
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)

  try {
    await act(async () => root.render(<ControlPanelPage actions={actions} />))
    const trigger = findButton("Nodes Manager")
    trigger.focus()
    await act(async () => trigger.click())
    const parentDialog = document.querySelector<HTMLElement>('[aria-labelledby="cp-title"]')!
    const managerDialog = document.querySelector<HTMLElement>(
      '[aria-labelledby="cp-nodes-manager-title"]',
    )!
    expect(parentDialog.hasAttribute("inert")).toBe(true)
    expect(parentDialog.getAttribute("aria-hidden")).toBe("true")
    expect(document.activeElement).toBe(
      managerDialog.querySelector('input[name="nodes-manager-search"]'),
    )

    await act(async () => dispatchKey(document.activeElement as HTMLElement, "Escape"))
    expect(document.querySelector('[aria-labelledby="cp-nodes-manager-title"]')).toBeNull()
    expect(parentDialog.hasAttribute("inert")).toBe(false)
    expect(document.activeElement).toBe(trigger)

    await act(async () => trigger.click())
    expect(document.querySelector('[aria-labelledby="cp-nodes-manager-title"]')).not.toBeNull()
    await act(async () => actions.close())
    expect(document.querySelector('[aria-labelledby="cp-nodes-manager-title"]')).toBeNull()
    expect(document.querySelector('[aria-labelledby="cp-title"]')).toBeNull()

    await act(async () => updatePanel({ isOpen: true }))
    expect(document.querySelector('[aria-labelledby="cp-title"]')).not.toBeNull()
    expect(document.querySelector('[aria-labelledby="cp-nodes-manager-title"]')).toBeNull()
    await act(async () => findButton("Nodes Manager").click())
    expect(document.querySelector('[aria-labelledby="cp-nodes-manager-title"]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
