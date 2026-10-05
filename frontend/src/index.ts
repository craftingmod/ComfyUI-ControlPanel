import { app } from "../../scripts/app.js"
import { createControlPanelController } from "./components/controlPanel.ts"
import { API_ROUTES, EXTENSION_NAME, SETTINGS_IDS } from "./constants.ts"
import { createTranslator } from "./i18n/messages.ts"
import type { MetadataNode } from "./services/cnrMetadata.ts"
import { createCnrMetadataController } from "./services/cnrMetadataController.ts"
import { installStylesheet } from "./stylesheet.ts"
import type { ComfySettingId, ManagerExtension } from "./types.ts"
import { ensureGlobalStyles } from "./ui/dom.ts"

installStylesheet(import.meta.url)
ensureGlobalStyles()

const translateHostLocale = createTranslator(() =>
  app.extensionManager.setting?.get?.("Comfy.Locale"),
)

function translateCurrent(
  key: Parameters<typeof translateHostLocale>[0],
  values?: Parameters<typeof translateHostLocale>[1],
): string {
  return translateHostLocale(key, values)
}

type ControlPanelSettingsResponse = {
  manager_repository_data_override?: boolean
  manager_repository_data_channel?: string
  allow_flagged_version_as_latest?: boolean
}

let managerSettingsSynced = false

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

async function fetchJson(
  route: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
    throw new ControlPanelFetchError(
      `HTTP ${response.status} for ${route}: ${text.trim() || response.statusText}`,
      response.status,
    )
  }
  if (!response.ok || data.ok === false) {
    throw new ControlPanelFetchError(
      typeof data.error === "string" ? data.error : response.statusText,
      response.status,
    )
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
  await Promise.resolve(
    app.extensionManager.setting.set(
      settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_OVERRIDE),
      data.manager_repository_data_override === true,
    ),
  )
  await Promise.resolve(
    app.extensionManager.setting.set(
      settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_CHANNEL),
      data.manager_repository_data_channel === "github" ? "github" : "jsdelivr",
    ),
  )
  await Promise.resolve(
    app.extensionManager.setting.set(
      settingId(SETTINGS_IDS.ALLOW_FLAGGED_VERSION_AS_LATEST),
      data.allow_flagged_version_as_latest === true,
    ),
  )
  managerSettingsSynced = true
}

function updateManagerBooleanSetting(route: string, enabled: boolean): void {
  void fetchJson(route, { enabled })
    .then(async () => {
      if (
        route === API_ROUTES.ALLOW_FLAGGED_VERSION_AS_LATEST &&
        controlPanel.nodesManager.getSnapshot().isOpen
      ) {
        await controlPanel.nodesManager.refresh()
      }
    })
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
  void fetchJson(API_ROUTES.MANAGER_REPOSITORY_DATA_CHANNEL, { channel: normalizedChannel }).catch(
    (error) => {
      const message = error instanceof Error ? error.message : String(error)
      app.extensionManager.toast.add({
        severity: "error",
        summary: "ComfyUI-ControlPanel",
        detail: message,
        life: 5000,
      })
    },
  )
}

function createExtensionObject(): ManagerExtension {
  return {
    name: EXTENSION_NAME,
    commands: [
      {
        id: "control-panel.open",
        label: () => translateCurrent("command.open"),
        icon: "pi pi-wrench",
        function: controlPanel.open,
      },
      {
        id: "control-panel.fix-cnr-id",
        label: () => translateCurrent("command.repairMetadata"),
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
        category: ["ControlPanel", "General", "ComfyUI-ControlPanel"],
        type: () => {
          const spanEl = document.createElement("span")
          const linkEl = document.createElement("a")
          linkEl.href = "https://github.com/craftingmod/comfyui-controlpanel"
          linkEl.target = "_blank"
          linkEl.rel = "noopener noreferrer"
          linkEl.textContent = translateCurrent("settings.homepage")
          spanEl.dataset.templateTheme = ""
          linkEl.style.paddingRight = "var(--space-3sm)"
          spanEl.append(linkEl)
          return spanEl
        },
        defaultValue: undefined,
      },
      {
        id: settingId(SETTINGS_IDS.PIN_NODES_MANAGER_TO_TOOLBAR),
        name: translateCurrent("settings.pinNodesManager"),
        category: ["ControlPanel", "General", "Pin Nodes Manager to toolbar"],
        type: "boolean",
        defaultValue: false,
      },
      {
        id: settingId(SETTINGS_IDS.DEBUG_LOGGING),
        name: translateCurrent("settings.debugLogging"),
        category: ["ControlPanel", "General", "Enable Debug Logging"],
        type: "boolean",
        tooltip: translateCurrent("settings.debugLoggingTooltip"),
        defaultValue: false,
      },
      {
        id: settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_OVERRIDE),
        name: translateCurrent("settings.repositoryOverride"),
        category: ["ControlPanel", "Manager", "Replace Manager Repository Data"],
        type: "boolean",
        tooltip: translateCurrent("settings.repositoryOverrideTooltip"),
        defaultValue: false,
        onChange: (value) => {
          if (managerSettingsSynced) {
            updateManagerBooleanSetting(API_ROUTES.MANAGER_REPOSITORY_DATA_OVERRIDE, value === true)
          }
        },
      },
      {
        id: settingId(SETTINGS_IDS.MANAGER_REPOSITORY_DATA_CHANNEL),
        name: translateCurrent("settings.repositoryDataSource"),
        category: ["ControlPanel", "Manager", "Manager Repository Data Source"],
        type: "combo",
        options: [
          { value: "jsdelivr", text: "jsDelivr" },
          { value: "github", text: "GitHub Raw" },
        ],
        tooltip: translateCurrent("settings.repositoryDataSourceTooltip"),
        defaultValue: "jsdelivr",
        onChange: (value) => {
          if (managerSettingsSynced) {
            updateManagerRepositoryDataChannelSetting(value)
          }
        },
      },
      {
        id: settingId(SETTINGS_IDS.ALLOW_FLAGGED_VERSION_AS_LATEST),
        name: translateCurrent("settings.allowFlaggedLatest"),
        category: ["ControlPanel", "Manager", "Use flagged version as latest"],
        type: "boolean",
        tooltip: translateCurrent("settings.allowFlaggedLatestTooltip"),
        defaultValue: false,
        onChange: (value) => {
          if (managerSettingsSynced) {
            updateManagerBooleanSetting(API_ROUTES.ALLOW_FLAGGED_VERSION_AS_LATEST, value === true)
          }
        },
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
    get actionBarButtons() {
      const buttons = [
        {
          icon: "icon-[lucide--wrench]",
          label: translateCurrent("actionBar.panel"),
          tooltip: translateCurrent("actionBar.tooltip"),
          onClick: controlPanel.open,
        },
      ]
      if (readBooleanSetting(SETTINGS_IDS.PIN_NODES_MANAGER_TO_TOOLBAR)) {
        buttons.push({
          icon: "icon-[lucide--plug]",
          label: "Nodes",
          tooltip: translateCurrent("actionBar.nodesTooltip"),
          onClick: () => {
            void controlPanel.openNodesManager()
          },
        })
      }
      return buttons
    },
  }
}

async function registerControlPanelExtension(): Promise<void> {
  if (await shouldRegisterControlPanel()) {
    void cnrMetadata.initialize()
    app.registerExtension(createExtensionObject())
  }
}

await registerControlPanelExtension()
