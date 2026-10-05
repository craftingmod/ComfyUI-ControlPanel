import { afterEach, expect, it, mock, vi } from "bun:test"

import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import { API_ROUTES, SETTINGS_IDS } from "../../src/constants.ts"
import type { ManagerExtension } from "../../src/types.ts"

const openPanel = vi.fn()
const openNodesManager = vi.fn(async () => undefined)
const refreshManager = vi.fn(async () => undefined)
let managerOpen = false

await mock.module("../../src/components/controlPanel.ts", () => ({
  createControlPanelController: () => ({
    open: openPanel,
    openNodesManager,
    nodesManager: {
      open: openNodesManager,
      getSnapshot: () => ({ isOpen: managerOpen }),
      refresh: refreshManager,
    },
  }),
}))
await mock.module("../../src/services/cnrMetadataController.ts", () => ({
  createCnrMetadataController: () => ({ initialize: vi.fn(), fixActiveWorkflow: vi.fn() }),
}))

afterEach(() => {
  mock.restore()
})

it("categorizes every setting and restores the flagged toggle before posting user changes", async () => {
  // Isolate the virtual ComfyUI module from concurrent Bun.build() tests.
  if (process.env.CONTROLPANEL_ENTRYPOINT_TEST !== "1") {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--preload",
        "./frontend/test/setup.ts",
        "./frontend/test/loader/settings.test.ts",
      ],
      {
        env: { ...process.env, CONTROLPANEL_ENTRYPOINT_TEST: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stdout + stderr)
    expect(exitCode).toBe(0)
    return
  }
  let extension: ManagerExtension | undefined
  let pinNodesManager = false
  const fetchApi = vi.fn(async (route: string) => {
    // A slow status response must not let ComfyUI finish loading before registration.
    if (route === API_ROUTES.STATUS) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return new Response(
      JSON.stringify(
        route === API_ROUTES.SETTINGS ? { allow_flagged_version_as_latest: true } : { ok: true },
      ),
    )
  })
  const set = vi.fn(async (id: string, value: unknown) => {
    extension?.settings?.find((setting) => setting.id === id)?.onChange?.(value)
  })
  const app = {
    api: { fetchApi },
    extensionManager: {
      setting: {
        set,
        get: (id: string) =>
          id === SETTINGS_IDS.PIN_NODES_MANAGER_TO_TOOLBAR ? pinNodesManager : undefined,
      },
      toast: { add: vi.fn() },
    },
    registerExtension: (registered: ManagerExtension) => {
      extension = registered
    },
  } as unknown as ComfyApp
  expect(Reflect.has(globalThis, "app")).toBeFalse()
  Bun.plugin({
    name: "comfyui-runtime-test",
    setup(build) {
      build.onResolve({ filter: /scripts\/app\.js$/ }, () => ({
        path: "app",
        namespace: "comfy-test",
      }))
      build.onLoad({ filter: /.*/, namespace: "comfy-test" }, () => ({
        exports: { app },
        loader: "object",
      }))
    },
  })
  await import("../../src/index.ts")
  expect(extension).toBeDefined()
  const panelButton = extension!.actionBarButtons?.find((button) => button.label === "Panel")
  expect(panelButton).toBeDefined()
  panelButton!.onClick()
  expect(openPanel).toHaveBeenCalledTimes(1)
  const command = extension!.commands?.find((item) => item.id === "control-panel.open")
  expect(command).toBeDefined()
  await command!.function()
  expect(openPanel).toHaveBeenCalledTimes(2)
  const pinSetting = extension!.settings!.find(
    (setting) => String(setting.id) === SETTINGS_IDS.PIN_NODES_MANAGER_TO_TOOLBAR,
  )!
  expect(pinSetting.name).toBe("Pin Nodes Manager to toolbar")
  expect(pinSetting.defaultValue).toBe(false)
  expect(extension!.actionBarButtons?.map((button) => button.label)).toEqual(["Panel"])
  pinNodesManager = true
  const nodesButton = extension!.actionBarButtons!.find((button) => button.label === "Nodes")!
  expect(nodesButton.icon).toBe("icon-[lucide--plug]")
  nodesButton.onClick()
  expect(openPanel).toHaveBeenCalledTimes(2)
  expect(openNodesManager).toHaveBeenCalledTimes(1)
  pinNodesManager = false
  expect(extension!.actionBarButtons?.map((button) => button.label)).toEqual(["Panel"])
  expect(
    extension!.menuCommands?.some((group) => group.commands.includes("control-panel.open")),
  ).toBeTrue()
  const settings = extension!.settings!
  expect(
    settings.every(
      (setting) => setting.category?.length === 3 && setting.category[0] === "ControlPanel",
    ),
  ).toBe(true)
  const toggle = settings.find(
    (setting) => String(setting.id) === SETTINGS_IDS.ALLOW_FLAGGED_VERSION_AS_LATEST,
  )!
  expect(toggle.defaultValue).toBe(false)
  expect(toggle.name).toBe("Use flagged version as latest")
  managerOpen = true
  toggle.onChange?.(false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(refreshManager).not.toHaveBeenCalled()
  expect(fetchApi).not.toHaveBeenCalledWith(
    API_ROUTES.ALLOW_FLAGGED_VERSION_AS_LATEST,
    expect.anything(),
  )

  fetchApi.mockClear()
  await extension!.setup?.(app)
  expect(fetchApi.mock.calls.map(([route]) => route)).toEqual([API_ROUTES.SETTINGS])
  expect(set).toHaveBeenCalledWith(SETTINGS_IDS.ALLOW_FLAGGED_VERSION_AS_LATEST, true)
  expect(fetchApi).not.toHaveBeenCalledWith(
    API_ROUTES.ALLOW_FLAGGED_VERSION_AS_LATEST,
    expect.anything(),
  )
  toggle.onChange?.(false)
  expect(fetchApi).toHaveBeenCalledWith(
    API_ROUTES.ALLOW_FLAGGED_VERSION_AS_LATEST,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(refreshManager).toHaveBeenCalledTimes(1)
})
