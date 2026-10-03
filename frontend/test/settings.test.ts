import { afterEach, expect, it, vi } from "vitest"
import { API_ROUTES, SETTINGS_IDS } from "../src/constants.ts"
import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import type { ManagerExtension } from "../src/types.ts"

vi.mock("../src/components/controlPanel.ts", () => ({
  createControlPanelController: () => ({ open: vi.fn() }),
}))
vi.mock("../src/services/cnrMetadataController.ts", () => ({
  createCnrMetadataController: () => ({ initialize: vi.fn(), fixActiveWorkflow: vi.fn() }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it("categorizes every setting and restores the flagged toggle before posting user changes", async () => {
  let extension: ManagerExtension | undefined
  const fetchApi = vi.fn(async (route: string) => new Response(JSON.stringify(
    route === API_ROUTES.SETTINGS ? { allow_flagged_version_as_latest: true } : { ok: true },
  )))
  const set = vi.fn(async (id: string, value: unknown) => {
    extension?.settings?.find(setting => setting.id === id)?.onChange?.(value)
  })
  const app = {
    api: { fetchApi },
    extensionManager: { setting: { set }, toast: { add: vi.fn() } },
    registerExtension: (registered: ManagerExtension) => { extension = registered },
  } as unknown as ComfyApp
  vi.stubGlobal("app", app)
  await import("../src/index.ts")
  await vi.waitFor(() => expect(extension).toBeDefined())
  const settings = extension!.settings!
  expect(settings.every(setting => setting.category?.length === 3 && setting.category[0] === "ControlPanel")).toBe(true)
  const toggle = settings.find(setting => String(setting.id) === SETTINGS_IDS.ALLOW_FLAGGED_VERSION_AS_LATEST)!
  expect(toggle.defaultValue).toBe(false)
  toggle.onChange?.(false)
  expect(fetchApi).not.toHaveBeenCalledWith(API_ROUTES.ALLOW_FLAGGED_VERSION_AS_LATEST, expect.anything())

  await extension!.setup?.(app)
  expect(set).toHaveBeenCalledWith(SETTINGS_IDS.ALLOW_FLAGGED_VERSION_AS_LATEST, true)
  expect(fetchApi).not.toHaveBeenCalledWith(API_ROUTES.ALLOW_FLAGGED_VERSION_AS_LATEST, expect.anything())
  toggle.onChange?.(false)
  expect(fetchApi).toHaveBeenCalledWith(API_ROUTES.ALLOW_FLAGGED_VERSION_AS_LATEST, expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ enabled: false }),
  }))
})
