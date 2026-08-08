import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { API_ROUTES, EXTENSION_NAME, SETTINGS_IDS } from "./constants.ts"
import { createControlPanelController } from "./components/controlPanel.ts"
import { createCnrMetadataController } from "./services/cnrMetadataController.ts"
import type { MetadataNode } from "./services/cnrMetadata.ts"
import type { ComfySettingId, ManagerExtension } from "./types.ts"

declare global {
  const app: ComfyApp

  interface Window {
    app: ComfyApp
  }
}

const ACTION_BAR_BUTTON_TOOLTIP = "Open ControlPanel"

type ControlPanelSettingsResponse = {
  manager_repository_data_override?: boolean
  manager_repository_data_channel?: string
}

class ControlPanelFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ControlPanelFetchError"
  }
}

function getSetting<T>(id: string): T | undefined {
  return app.extensionManager.setting.get<T>(id)
}

function readBooleanSetting(id: string): boolean {
  return getSetting<boolean>(id) ?? false
}

function settingId(id: string): ComfySettingId {
  return id as ComfySettingId
}

const cnrMetadata = createCnrMetadataController(app)
const controlPanel = createControlPanelController({
  app,
  readBooleanSetting,
  fixCnrId: cnrMetadata.fixActiveWorkflow,
})

async function fetchJson(route: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await app.api.fetchApi(route, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let data: Record<string, unknown>
  try {
    data = (text ? JSON.parse(text) : {}) as Record<string, unknown>
  } catch {
    throw new ControlPanelFetchError(`HTTP ${response.status} for ${route}: ${text.trim() || response.statusText}`, response.status)
  }
  if (!response.ok || data.ok === false) {
    throw new ControlPanelFetchError(String(data.error ?? response.statusText), response.status)
  }
  return data
}

async function shouldRegisterControlPanel(): Promise<boolean> {
  try {
    await fetchJson(API_ROUTES.STATUS)
    return true
  } catch (error) {
    if (error instanceof ControlPanelFetchError && error.status === 403) {
      console.info("ComfyUI-ControlPanel is hidden because this client is not localhost.")
      return false
    }
    return true
  }
}

async function syncManagerRepositoryDataOverrideSetting(): Promise<void> {
  const data = (await fetchJson(API_ROUTES.SETTINGS)) as ControlPanelSettingsResponse
  app.extensionManager.setting.set(
    settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_OVERRIDE),
    data.manager_repository_data_override === true,
  )
  app.extensionManager.setting.set(
    settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_CHANNEL),
    data.manager_repository_data_channel === "github" ? "github" : "jsdelivr",
  )
}

function updateManagerRepositoryDataOverrideSetting(enabled: boolean): void {
  void fetchJson(API_ROUTES.MANAGER_REPOSITORY_DATA_OVERRIDE, { enabled })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      app.extensionManager.toast.add({
        severity: "error",
        summary: "ComfyUI-ControlPanel",
        detail: message,
        life: 5000,
      })
    })
}

function updateManagerRepositoryDataChannelSetting(channel: unknown): void {
  const normalizedChannel = channel === "github" ? "github" : "jsdelivr"
  void fetchJson(API_ROUTES.MANAGER_REPOSITORY_DATA_CHANNEL, { channel: normalizedChannel })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      app.extensionManager.toast.add({
        severity: "error",
        summary: "ComfyUI-ControlPanel",
        detail: message,
        life: 5000,
      })
    })
}

function createExtensionObject(): ManagerExtension {
  return {
    name: EXTENSION_NAME,
    commands: [
      {
        id: "control-panel.open",
        label: "ComfyUI-ControlPanel",
        icon: "pi pi-wrench",
        function: controlPanel.open,
      },
      {
        id: "control-panel.fix-cnr-id",
        label: "Repair Metadata",
        icon: "icon-[lucide--tags]",
        function: cnrMetadata.fixActiveWorkflow,
      },
    ],
    menuCommands: [
      {
        path: ["ComfyUI-ControlPanel"],
        commands: ["control-panel.open", "control-panel.fix-cnr-id"],
      },
    ],
    settings: [
      {
        id: settingId(SETTINGS_IDS.VERSION),
        name: "ComfyUI-ControlPanel",
        type: () => {
          const spanEl = document.createElement("span")
          const linkEl = document.createElement("a")
          linkEl.href = "https://github.com/craftingmod/comfyui-controlpanel"
          linkEl.target = "_blank"
          linkEl.rel = "noopener noreferrer"
          linkEl.textContent = "Homepage"
          linkEl.style.paddingRight = "12px"
          spanEl.append(linkEl)
          return spanEl
        },
        defaultValue: undefined,
      },
      {
        id: settingId(SETTINGS_IDS.DEBUG_LOGGING),
        name: "Enable Debug Logging",
        type: "boolean",
        tooltip: "Show detailed debug logs in browser console during manager operations",
        defaultValue: false,
      },
      {
        id: settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_OVERRIDE),
        name: "Replace Manager Repository Data",
        type: "boolean",
        tooltip: "Use ControlPanel cached Manager repository data and force ComfyUI Manager offline channel settings",
        defaultValue: false,
        onChange: (value) => {
          updateManagerRepositoryDataOverrideSetting(value === true)
        },
      },
      {
        id: settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_CHANNEL),
        name: "Manager Repository Data Source",
        type: "combo",
        options: [
          { value: "jsdelivr", text: "jsDelivr" },
          { value: "github", text: "GitHub Raw" },
        ],
        tooltip: "Choose where ControlPanel fetches ComfyUI Manager repository data",
        defaultValue: "jsdelivr",
        onChange: updateManagerRepositoryDataChannelSetting,
      },
    ],
    async init() {
      await cnrMetadata.initialize()
    },
    nodeCreated(node) {
      cnrMetadata.fillNode(node as unknown as MetadataNode)
    },
    loadedGraphNode(node) {
      cnrMetadata.fillNode(node as unknown as MetadataNode)
    },
    async setup() {
      await syncManagerRepositoryDataOverrideSetting().catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        app.extensionManager.toast.add({
          severity: "warn",
          summary: "ComfyUI-ControlPanel",
          detail: message,
          life: 5000,
        })
      })
    },
    actionBarButtons: [
      {
        icon: "icon-[lucide--wrench]",
        label: "Panel",
        tooltip: ACTION_BAR_BUTTON_TOOLTIP,
        onClick: controlPanel.open,
      },
    ],
  }
}

async function registerControlPanelExtension(): Promise<void> {
  if (await shouldRegisterControlPanel()) {
    void cnrMetadata.initialize()
    app.registerExtension(createExtensionObject())
  }
}

void registerControlPanelExtension()
