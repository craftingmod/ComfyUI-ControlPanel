import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { EXTENSION_NAME, SETTINGS_IDS } from "./constants.ts"
import { createControlPanelController } from "./components/controlPanel.ts"
import type { ComfySettingId, ManagerExtension } from "./types.ts"

declare global {
  const app: ComfyApp

  interface Window {
    app: ComfyApp
  }
}

const ACTION_BAR_BUTTON_TOOLTIP = "Open ComfyUI-ControlPanel"

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
    ],
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
