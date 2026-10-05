import { expect, it, vi } from "bun:test"

import { act } from "react"
import { createRoot } from "react-dom/client"

import { createControlPanelController } from "../../src/components/controlPanel.ts"
import type {
  ControlPanelActions,
  ControlPanelViewState,
} from "../../src/components/controlPanelTypes.ts"
import { API_ROUTES } from "../../src/constants.ts"
import { ControlPanelPage } from "../../src/pages/ControlPanelPage.tsx"
import type {
  NodesManagerController,
  NodesManagerSnapshot,
} from "../../src/services/nodesManagerController.ts"
import type { JsonObject } from "../../src/types.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  )
  if (!button) throw new Error(`Missing button: ${text}`)
  return button
}

function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set
  setter?.call(input, value)
  input.dispatchEvent(
    new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  )
}

function createManagerControllerMock() {
  let snapshot: NodesManagerSnapshot = {
    isOpen: false,
    catalogStatus: "idle",
    installedStatus: "idle",
    installed: [],
    packs: [],
    workflowStatus: "idle",
    workflowAvailabilityKnown: false,
    workflowPacks: [],
    workflowMissingPacks: [],
    workflowDiagnostics: [],
    workflowMappingIssueCount: 0,
    operations: {},
    versions: {},
    checking: false,
  }
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
    loadVersions: vi.fn(async () => undefined),
    submit: vi.fn(async () => false),
    retryQueueStart: vi.fn(async () => false),
    submitAll: vi.fn(async () => undefined),
    browseLocalFolder: vi.fn(async () => undefined),
  }
  return { controller, update }
}

async function mountControlPanel(overrides: Partial<ControlPanelActions> = {}) {
  let view: ControlPanelViewState = {
    isOpen: true,
    log: "Retained operation log",
    managerCacheControlsEnabled: true,
    managerCacheStatus: "panel.managerCacheEnabled",
    updateCheckOutput: "",
  }
  const listeners = new Set<() => void>()
  const updateView = (update: Partial<ControlPanelViewState>) => {
    view = { ...view, ...update }
    for (const listener of listeners) listener()
  }
  const manager = createManagerControllerMock()
  const actions: ControlPanelActions = {
    getSnapshot: () => view,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    nodesManager: manager.controller,
    close: vi.fn(() => {
      manager.controller.close()
      updateView({ isOpen: false })
    }),
    clearLog: vi.fn(() => updateView({ log: "" })),
    toast: vi.fn(),
    runOperation: vi.fn(async () => undefined),
    startUpdateJob: vi.fn(async () => undefined),
    refreshPanelStatus: vi.fn(async () => undefined),
    showStatusJson: vi.fn(async () => undefined),
    repairMetadata: vi.fn(async () => undefined),
    listSnapshots: vi.fn(async () => ["snapshot-one", "snapshot-two"]),
    restoreSnapshot: vi.fn(async (_target, onConfirmed) => onConfirmed()),
    backupInstalledNodes: vi.fn(async () => undefined),
    restoreNodesFromFile: vi.fn(async () => undefined),
    showEnvironment: vi.fn(async () => ({ environment: { python: { version: "test" } } })),
    showUpdateCheck: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    rebuildManagerCache: vi.fn(async () => undefined),
    ...overrides,
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<ControlPanelPage actions={actions} />))

  return {
    actions,
    updateView,
    host,
    destroy: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

function dispatchKey(element: HTMLElement, key: string, shiftKey = false): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
  )
}

function stubIntervals() {
  const originalSetInterval = window.setInterval
  const originalClearInterval = window.clearInterval
  let nextId = 1
  const scheduled: number[] = []
  const cleared: number[] = []
  window.setInterval = ((..._args: Parameters<typeof window.setInterval>) => {
    const id = nextId++
    scheduled.push(id)
    return id
  }) as typeof window.setInterval
  window.clearInterval = ((id: number) => {
    cleared.push(id)
  }) as typeof window.clearInterval
  return {
    scheduled,
    cleared,
    restore: () => {
      window.setInterval = originalSetInterval
      window.clearInterval = originalClearInterval
    },
  }
}

it("confirms the selected snapshot before posting and clears its job poll on close", async () => {
  const timers = stubIntervals()
  const fetchApi = vi.fn(async (route: string) => {
    const body =
      route === API_ROUTES.SNAPSHOT_RESTORE
        ? {
            job: {
              id: "restore-job",
              label: "Restore Snapshot",
              status: "running",
              logs: [],
            },
          }
        : route === API_ROUTES.STATUS
          ? { settings: { manager_repository_data_override: true } }
          : {}
    return new Response(JSON.stringify(body))
  })
  const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const app = {
    api: { fetchApi },
    extensionManager: {
      dialog: { confirm },
      toast: { add: vi.fn() },
    },
  } as unknown as import("@comfyorg/comfyui-frontend-types").ComfyApp
  const controller = createControlPanelController({
    app,
    readBooleanSetting: () => false,
    fixCnrId: async () => undefined,
  })
  const cancelled = vi.fn()
  const confirmed = vi.fn()

  try {
    await act(async () => {
      controller.open()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => controller.restoreSnapshot("cancelled", cancelled))
    expect(cancelled).not.toHaveBeenCalled()
    expect(fetchApi).not.toHaveBeenCalledWith(API_ROUTES.SNAPSHOT_RESTORE, expect.anything())

    await act(async () => controller.restoreSnapshot("selected-snapshot", confirmed))
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining('"selected-snapshot"') }),
    )
    expect(confirmed).toHaveBeenCalledTimes(1)
    expect(fetchApi).toHaveBeenCalledWith(
      API_ROUTES.SNAPSHOT_RESTORE,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ target: "selected-snapshot" }),
      }),
    )
    expect(timers.scheduled).toHaveLength(1)

    await act(async () => controller.close())
    expect(timers.cleared).toEqual(timers.scheduled)
    await act(async () => {
      controller.open()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(timers.scheduled).toHaveLength(1)
  } finally {
    await act(async () => controller.close())
    timers.restore()
  }
})

it("does not start status polling when a job POST resolves after the Panel closes", async () => {
  const timers = stubIntervals()
  const jobResponse = deferred<Response>()
  const fetchApi = vi.fn(async (route: string) => {
    if (route === API_ROUTES.UPDATE_COMFYUI) return await jobResponse.promise
    const body =
      route === API_ROUTES.STATUS ? { settings: { manager_repository_data_override: true } } : {}
    return new Response(JSON.stringify(body))
  })
  const app = {
    api: { fetchApi },
    extensionManager: { toast: { add: vi.fn() }, dialog: { confirm: vi.fn(async () => true) } },
  } as unknown as import("@comfyorg/comfyui-frontend-types").ComfyApp
  const controller = createControlPanelController({
    app,
    readBooleanSetting: () => false,
    fixCnrId: async () => undefined,
  })
  let startJob!: Promise<void>

  try {
    await act(async () => {
      controller.open()
      await new Promise((resolve) => setTimeout(resolve, 0))
      startJob = controller.startUpdateJob("panel.action.updateComfyUI", API_ROUTES.UPDATE_COMFYUI)
    })
    expect(fetchApi).toHaveBeenCalledWith(
      API_ROUTES.UPDATE_COMFYUI,
      expect.objectContaining({ method: "POST" }),
    )
    await act(async () => controller.close())

    jobResponse.resolve(
      new Response(
        JSON.stringify({
          job: { id: "late-job", label: "Update ComfyUI", status: "running", logs: [] },
        }),
      ),
    )
    await act(async () => startJob)
    expect(timers.scheduled).toEqual([])

    await act(async () => {
      controller.open()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(timers.scheduled).toEqual([])
  } finally {
    await act(async () => controller.close())
    timers.restore()
  }
})

it("opens the existing Git installer from Nodes Manager without replacing the Panel action", async () => {
  const mounted = await mountControlPanel()
  try {
    expect(buttonByText("Install via Git URL")).toBeDefined()
    await act(async () => mounted.actions.nodesManager.open())
    const addGit = buttonByText("Add git node")
    expect(addGit.querySelector(".lucide-git-merge")).not.toBeNull()
    await act(async () => {
      addGit.focus()
      addGit.click()
    })
    const manager = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="cp-nodes-manager-title"]',
    )!
    expect(manager.hasAttribute("inert")).toBe(true)
    const gitDialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="cp-git-install-title"]',
    )!
    await act(async () =>
      setInputValue(
        document.querySelector<HTMLInputElement>("#cp-git-url")!,
        "https://example.test/nodes.git",
      ),
    )
    await act(async () =>
      Array.from(gitDialog.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Install")!
        .click(),
    )
    expect(mounted.actions.runOperation).toHaveBeenCalledWith(
      "git.title",
      API_ROUTES.INSTALL_GIT_URL,
      {
        url: "https://example.test/nodes.git",
      },
    )
    expect(document.querySelector('[aria-labelledby="cp-git-install-title"]')).toBeNull()
    expect(manager.hasAttribute("inert")).toBe(false)
    expect(mounted.actions.nodesManager.getSnapshot().isOpen).toBe(true)
    expect(document.activeElement === addGit).toBe(true)
    await act(async () => mounted.actions.nodesManager.close())
    expect(buttonByText("Install via Git URL").disabled).toBe(false)
  } finally {
    await mounted.destroy()
  }
})

it("keeps the operation log and Git form values when the Panel closes and reopens", async () => {
  const panel = await mountControlPanel()
  try {
    await act(async () => buttonByText("Install via Git URL").click())
    const url = document.querySelector<HTMLInputElement>("#cp-git-url")!
    const folder = document.querySelector<HTMLInputElement>("#cp-folder-name")!
    await act(async () => {
      setInputValue(url, "https://example.test/nodes.git")
      setInputValue(folder, "saved-nodes")
    })

    await act(async () => panel.actions.close())
    expect(
      document.querySelector('[role="dialog"][aria-labelledby="cp-git-install-title"]'),
    ).toBeNull()
    await act(async () => panel.updateView({ isOpen: true }))
    expect(
      document.querySelector('[role="dialog"][aria-labelledby="cp-title"]')?.textContent,
    ).toContain("Retained operation log")
    await act(async () => buttonByText("Install via Git URL").click())
    expect(document.querySelector<HTMLInputElement>("#cp-git-url")?.value).toBe(
      "https://example.test/nodes.git",
    )
    expect(document.querySelector<HTMLInputElement>("#cp-folder-name")?.value).toBe("saved-nodes")
  } finally {
    await panel.destroy()
  }
})

it("restores the selected snapshot and traps, escapes, and restores dialog focus", async () => {
  const panel = await mountControlPanel()
  try {
    const trigger = buttonByText("Restore Snapshot")
    trigger.focus()
    await act(async () => trigger.click())
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="cp-snapshot-restore-title"]',
    )!
    const select = dialog.querySelector<HTMLSelectElement>("#cp-snapshot-select")!
    expect(document.activeElement).toBe(select)
    await act(async () => setInputValue(select, "snapshot-two"))

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    )
    focusable[0]!.focus()
    await act(async () => dispatchKey(focusable[0]!, "Tab", true))
    expect(document.activeElement).toBe(focusable[focusable.length - 1])
    focusable[focusable.length - 1]!.focus()
    await act(async () => dispatchKey(focusable[focusable.length - 1]!, "Tab"))
    expect(document.activeElement).toBe(focusable[0])
    await act(async () => dispatchKey(focusable[0]!, "Escape"))
    expect(
      document.querySelector('[role="dialog"][aria-labelledby="cp-snapshot-restore-title"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await act(async () => trigger.click())
    const reopenedDialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="cp-snapshot-restore-title"]',
    )!
    const reopenedSelect = reopenedDialog.querySelector<HTMLSelectElement>("#cp-snapshot-select")!
    await act(async () => setInputValue(reopenedSelect, "snapshot-two"))
    await act(async () => buttonByText("Restore").click())
    expect(panel.actions.restoreSnapshot).toHaveBeenCalledTimes(1)
    expect(panel.actions.restoreSnapshot).toHaveBeenCalledWith("snapshot-two", expect.any(Function))
    expect(
      document.querySelector('[role="dialog"][aria-labelledby="cp-snapshot-restore-title"]'),
    ).toBeNull()
    expect(document.activeElement).toBe(trigger)
  } finally {
    await panel.destroy()
  }
})

it("ignores snapshot and environment responses from earlier openings", async () => {
  const firstSnapshots = deferred<string[] | undefined>()
  const secondSnapshots = deferred<string[] | undefined>()
  const firstEnvironment = deferred<JsonObject>()
  const secondEnvironment = deferred<JsonObject>()
  const listSnapshots = vi
    .fn()
    .mockReturnValueOnce(firstSnapshots.promise)
    .mockReturnValueOnce(secondSnapshots.promise)
  const showEnvironment = vi
    .fn()
    .mockReturnValueOnce(firstEnvironment.promise)
    .mockReturnValueOnce(secondEnvironment.promise)
  const panel = await mountControlPanel({ listSnapshots, showEnvironment })

  try {
    await act(async () => buttonByText("Restore Snapshot").click())
    await act(async () => panel.updateView({ isOpen: false }))
    await act(async () => panel.updateView({ isOpen: true }))
    await act(async () => buttonByText("Restore Snapshot").click())
    await act(async () => secondSnapshots.resolve(["new-snapshot"]))
    await act(async () => firstSnapshots.resolve(["stale-snapshot"]))
    expect(
      document.querySelector<HTMLSelectElement>("#cp-snapshot-select")?.options[0]?.value,
    ).toBe("new-snapshot")
    expect(
      document.querySelector<HTMLSelectElement>("#cp-snapshot-select")?.textContent,
    ).not.toContain("stale-snapshot")

    const showEnvironmentButton = buttonByText("Show Environment")
    await act(async () => showEnvironmentButton.click())
    const environmentDialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="cp-environment-title"]',
    )!
    await act(async () =>
      environmentDialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
    )
    await act(async () => buttonByText("Show Environment").click())
    await act(async () =>
      secondEnvironment.resolve({ environment: { python: { version: "current-result" } } }),
    )
    await act(async () =>
      firstEnvironment.resolve({ environment: { python: { version: "stale-result" } } }),
    )
    const currentDialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="cp-environment-title"]',
    )!
    expect(currentDialog.textContent).toContain("current-result")
    expect(currentDialog.textContent).not.toContain("stale-result")
  } finally {
    await panel.destroy()
  }
})

it("reports an environment loading error and permits selecting the same JSON file again", async () => {
  const panel = await mountControlPanel({
    showEnvironment: vi.fn(async () => {
      throw new Error("offline")
    }),
  })
  try {
    await act(async () => buttonByText("Show Environment").click())
    await act(async () => Promise.resolve())
    const environmentDialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="cp-environment-title"]',
    )!
    expect(environmentDialog.textContent).toContain("offline")

    const input = document.querySelector<HTMLInputElement>("#cp-node-restore-file")!
    let value = "selected.json"
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => value,
      set: (next: string) => {
        value = next
      },
    })
    Object.defineProperty(input, "files", { configurable: true, value: [] })
    input.click = vi.fn()
    const file = new File(["{}"], "nodes.json", { type: "application/json" })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => buttonByText("Restore Latest Nodes").click())
      expect(input.value).toBe("")
      value = "C:\\fakepath\\nodes.json"
      Object.defineProperty(input, "files", { configurable: true, value: [file] })
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })))
    }
    expect(input.accept).toBe(".json,application/json")
    expect(panel.actions.restoreNodesFromFile).toHaveBeenCalledTimes(2)
    expect(panel.actions.restoreNodesFromFile).toHaveBeenNthCalledWith(1, file)
    expect(panel.actions.restoreNodesFromFile).toHaveBeenNthCalledWith(2, file)
  } finally {
    await panel.destroy()
  }
})
