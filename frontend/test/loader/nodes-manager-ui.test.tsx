import { expect, it, vi } from "bun:test"

import { act } from "react"
import { createRoot } from "react-dom/client"

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

async function mountNodesManager(snapshot: NodesManagerSnapshot) {
  const manager = createManager(snapshot)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<NodesManagerPage controller={manager.controller} />))
  return {
    ...manager,
    destroy: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

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

    const chooseVersion = findButton("Choose a version…")
    await act(async () => chooseVersion.focus())
    expect(requestCount).toBe(0)
    await act(async () => chooseVersion.click())
    expect(requestedPacks).toEqual([pack])
    expect(requestCount).toBe(1)
    expect(chooseVersion.disabled).toBe(true)
    expect(chooseVersion.textContent).toContain("Loading versions…")
    expect(document.querySelector('select[name="version-example-pack"]')).toBeNull()

    await act(async () => {
      firstRequest.resolve(new Error("Registry temporarily unavailable."))
      await firstRequest.promise
    })
    expect(document.querySelector('select[name="version-example-pack"]')).toBeNull()
    expect(document.body.textContent).toContain(
      "Could not load versions: Registry temporarily unavailable.",
    )
    expect(findButton("Choose a version…").disabled).toBe(false)

    await act(async () => findButton("Retry").click())
    expect(requestedPacks).toEqual([pack, pack])
    expect(requestCount).toBe(2)
    expect(document.querySelector('select[name="version-example-pack"]')).toBeNull()
    expect(findButton("Loading versions…").disabled).toBe(true)

    await act(async () => {
      retryRequest.resolve([
        { version: "1.0.0", status: "Active" },
        { version: "0.9.0", status: "Flagged", status_reason: "Known security issue" },
      ])
      await retryRequest.promise
    })
    const selector = document.querySelector<HTMLSelectElement>(
      'select[name="version-example-pack"]',
    )!

    await act(async () => setValue(selector, "0.9.0"))
    expect(document.body.textContent).toContain("Known security issue")
    await act(async () => findButton("Install").click())

    expect(mounted.controller.submit).toHaveBeenCalledWith(pack, "install", "0.9.0")
  } finally {
    await mounted.destroy()
  }
})

it("limits results to 48 cards and resets pagination when a filter or search changes", async () => {
  const packs = Array.from({ length: 50 }, (_, index) => managedPack(`pack-${index + 1}`))
  const mounted = await mountNodesManager(managerSnapshot(packs))
  try {
    expect(
      document.querySelector<HTMLSelectElement>('select[name="nodes-manager-sort"]')?.value,
    ).toBe("downloads")
    expect(document.querySelectorAll("article")).toHaveLength(48)
    await act(async () => findButton("Next").click())
    expect(document.querySelectorAll("article")).toHaveLength(2)
    expect(document.body.textContent).toContain("Page 2 of 2")

    await act(async () => findButtonContaining("Not Installed").click())
    expect(document.querySelectorAll("article")).toHaveLength(48)
    expect(document.body.textContent).toContain("Page 1 of 2")

    const search = document.querySelector<HTMLInputElement>('input[name="nodes-manager-search"]')!
    await act(async () => setValue(search, "pack-50"))
    expect(document.querySelectorAll("article")).toHaveLength(1)
    expect(document.body.textContent).toContain("Page 1 of 1")
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
    expect(document.body.textContent).toContain("Pack removed-git-pack · uninstall")
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
    managerCacheStatus: "",
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
