import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { API_ROUTES, EXTENSION_NAME, SETTINGS_IDS } from "./constants.ts"
import { createControlPanelController } from "./components/controlPanel.ts"
import type { ComfySettingId, ManagerExtension } from "./types.ts"

declare global {
  const app: ComfyApp

  interface Window {
    app: ComfyApp
  }
}

const ACTION_BAR_BUTTON_TOOLTIP = "Open ComfyUI-ControlPanel"

type ControlPanelSettingsResponse = {
  manager_repository_data_override?: boolean
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

const controlPanel = createControlPanelController({ app, readBooleanSetting })

async function fetchJson(route: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await app.api.fetchApi(route, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = (await response.json()) as Record<string, unknown>
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.error ?? response.statusText))
  }
  return data
}

async function syncManagerRepositoryDataOverrideSetting(): Promise<void> {
  const data = (await fetchJson(API_ROUTES.SETTINGS)) as ControlPanelSettingsResponse
  app.extensionManager.setting.set(
    settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_OVERRIDE),
    data.manager_repository_data_override === true,
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
    ],
    menuCommands: [
      {
        path: ["ComfyUI-ControlPanel"],
        commands: ["control-panel.open"],
      },
    ],
    settings: [
      {
        id: settingId(SETTINGS_IDS.VERSION),
        name: "ComfyUI-ControlPanel",
        type: () => {
          const spanEl = document.createElement("span")
          const linkEl = document.createElement("a")
          linkEl.href = "https://github.com/craftingmod/comfyui-control-panel"
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
    ],
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
        label: "Manager",
        tooltip: ACTION_BAR_BUTTON_TOOLTIP,
        onClick: controlPanel.open,
      },
    ],
  }
}

app.registerExtension(createExtensionObject())
