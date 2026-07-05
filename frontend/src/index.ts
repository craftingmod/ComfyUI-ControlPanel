import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { debugLog } from "./debug.ts"
import { API_ROUTES, EXTENSION_NAME, SETTINGS_IDS } from "./constants.ts"

declare global {
  const app: ComfyApp

  interface Window {
    app: ComfyApp
  }
}

type JsonObject = Record<string, unknown>

let panelEl: HTMLElement | undefined
let logEl: HTMLPreElement | undefined
let urlInputEl: HTMLInputElement | undefined
let nameInputEl: HTMLInputElement | undefined

function getSetting<T>(id: string): T | undefined {
  return app.extensionManager.setting.get<T>(id)
}

function readBooleanSetting(id: string): boolean {
  return getSetting<boolean>(id) ?? false
}

function toast(severity: "success" | "info" | "warn" | "error", summary: string, detail: string): void {
  app.extensionManager.toast.add({ severity, summary, detail, life: 5000 })
}

function writeLog(message: string, payload?: unknown): void {
  if (!logEl) {
    return
  }

  const timestamp = new Date().toLocaleTimeString()
  const body = payload === undefined ? "" : `\n${JSON.stringify(payload, null, 2)}`
  logEl.textContent = `[${timestamp}] ${message}${body}\n\n${logEl.textContent ?? ""}`
}

async function fetchJson(route: string, body?: JsonObject): Promise<JsonObject> {
  const response = await app.api.fetchApi(route, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = (await response.json()) as JsonObject
  if (!response.ok || data.ok === false) {
    throw new Error(String(data.error ?? response.statusText))
  }
  return data
}

async function runOperation(label: string, route: string, body?: JsonObject): Promise<void> {
  writeLog(`${label} started.`)
  debugLog(readBooleanSetting, `${label} request`, { route, body })

  try {
    const data = await fetchJson(route, body)
    writeLog(`${label} completed.`, data)
    toast("success", "Manager Extension", `${label} completed.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeLog(`${label} failed: ${message}`)
    toast("error", "Manager Extension", message)
  }
}

function createButton(label: string, onClick: () => void, className = "cme-button"): HTMLButtonElement {
  const button = document.createElement("button")
  button.className = className
  button.type = "button"
  button.textContent = label
  button.addEventListener("click", onClick)
  return button
}

function ensureStyles(): void {
  if (document.getElementById("manager-extension-styles")) {
    return
  }

  const style = document.createElement("style")
  style.id = "manager-extension-styles"
  style.textContent = `
    .cme-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1200;
      display: grid;
      place-items: center;
      background: rgb(0 0 0 / 0.55);
    }
    .cme-panel {
      width: min(760px, calc(100vw - 32px));
      max-height: min(760px, calc(100vh - 32px));
      overflow: auto;
      padding: 20px;
      border: 1px solid rgb(255 255 255 / 0.16);
      border-radius: 8px;
      background: #18191d;
      color: #f1f3f7;
      box-shadow: 0 18px 48px rgb(0 0 0 / 0.36);
      font: 14px/1.45 system-ui, sans-serif;
    }
    .cme-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }
    .cme-title {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
    }
    .cme-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
    }
    .cme-field {
      display: grid;
      gap: 6px;
    }
    .cme-field-wide {
      grid-column: 1 / -1;
    }
    .cme-field label {
      color: #c9ced8;
      font-size: 12px;
      font-weight: 600;
    }
    .cme-field input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid rgb(255 255 255 / 0.18);
      border-radius: 6px;
      background: #22242a;
      color: #f1f3f7;
    }
    .cme-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 16px 0;
    }
    .cme-button {
      min-height: 42px;
      padding: 9px 12px;
      border: 1px solid rgb(255 255 255 / 0.14);
      border-radius: 6px;
      background: #2d3436;
      color: #f1f3f7;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    .cme-button:hover {
      background: #394245;
    }
    .cme-danger {
      background: #6b1610;
    }
    .cme-danger:hover {
      background: #842116;
    }
    .cme-close {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      padding: 0;
      font-size: 20px;
      line-height: 1;
    }
    .cme-log {
      min-height: 180px;
      max-height: 300px;
      overflow: auto;
      margin: 0;
      padding: 12px;
      border: 1px solid rgb(255 255 255 / 0.12);
      border-radius: 6px;
      background: #101115;
      color: #d6dae2;
      white-space: pre-wrap;
      word-break: break-word;
    }
    @media (max-width: 640px) {
      .cme-grid,
      .cme-actions {
        grid-template-columns: 1fr;
      }
    }
  `
  document.head.append(style)
}

function createPanel(): HTMLElement {
  ensureStyles()

  const backdrop = document.createElement("div")
  backdrop.className = "cme-backdrop"
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closePanel()
    }
  })

  const panel = document.createElement("section")
  panel.className = "cme-panel"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-modal", "true")
  panel.setAttribute("aria-labelledby", "cme-title")

  const header = document.createElement("div")
  header.className = "cme-header"

  const title = document.createElement("h2")
  title.id = "cme-title"
  title.className = "cme-title"
  title.textContent = "Manager Extension"

  const closeButton = createButton("×", closePanel, "cme-button cme-close")
  closeButton.setAttribute("aria-label", "Close")
  header.append(title, closeButton)

  const fields = document.createElement("div")
  fields.className = "cme-grid"

  const urlField = document.createElement("div")
  urlField.className = "cme-field cme-field-wide"
  const urlLabel = document.createElement("label")
  urlLabel.htmlFor = "cme-git-url"
  urlLabel.textContent = "Git URL"
  urlInputEl = document.createElement("input")
  urlInputEl.id = "cme-git-url"
  urlInputEl.placeholder = "https://github.com/user/comfyui-node-pack.git"
  urlField.append(urlLabel, urlInputEl)

  const nameField = document.createElement("div")
  nameField.className = "cme-field cme-field-wide"
  const nameLabel = document.createElement("label")
  nameLabel.htmlFor = "cme-folder-name"
  nameLabel.textContent = "Folder name"
  nameInputEl = document.createElement("input")
  nameInputEl.id = "cme-folder-name"
  nameInputEl.placeholder = "Optional"
  nameField.append(nameLabel, nameInputEl)
  fields.append(urlField, nameField)

  const actions = document.createElement("div")
  actions.className = "cme-actions"
  actions.append(
    createButton("Install via Git URL", () => {
      const url = urlInputEl?.value.trim() ?? ""
      const name = nameInputEl?.value.trim()
      void runOperation("Install via Git URL", API_ROUTES.INSTALL_GIT_URL, { url, ...(name ? { name } : {}) })
    }),
    createButton("Update All", () => {
      void runOperation("Update All", API_ROUTES.UPDATE_ALL)
    }),
    createButton("Update ComfyUI", () => {
      void runOperation("Update ComfyUI", API_ROUTES.UPDATE_COMFYUI)
    }),
    createButton("Restart", () => {
      if (window.confirm("Restart ComfyUI now?")) {
        void runOperation("Restart", API_ROUTES.RESTART, { confirm: true })
      }
    }, "cme-button cme-danger"),
  )

  logEl = document.createElement("pre")
  logEl.className = "cme-log"
  logEl.textContent = "Ready.\n"

  panel.append(header, fields, actions, logEl)
  backdrop.append(panel)
  return backdrop
}

function openPanel(): void {
  if (!panelEl) {
    panelEl = createPanel()
  }
  if (!panelEl.isConnected) {
    document.body.append(panelEl)
  }
  urlInputEl?.focus()
  void runOperation("Status", API_ROUTES.STATUS)
}

function closePanel(): void {
  panelEl?.remove()
}

app.registerExtension({
  name: EXTENSION_NAME,
  commands: [
    {
      id: "manager-extension.open",
      label: "Manager Extension",
      icon: "pi pi-wrench",
      function: openPanel,
    },
  ],
  menuCommands: [
    {
      path: ["Manager Extension"],
      commands: ["manager-extension.open"],
    },
  ],
  actionBarButtons: [
    {
      icon: "pi pi-wrench",
      label: "Manager",
      tooltip: "Open Manager Extension",
      onClick: openPanel,
    },
  ],
  settings: [
    {
      id: SETTINGS_IDS.VERSION,
      name: "Manager Extension 1.0.0",
      type: () => {
        const spanEl = document.createElement("span")
        const linkEl = document.createElement("a")
        linkEl.href = "https://github.com/craftingmod/comfyui-manager-extension"
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
      id: SETTINGS_IDS.DEBUG_LOGGING,
      name: "Enable Debug Logging",
      type: "boolean",
      tooltip: "Show detailed debug logs in browser console during manager operations",
      defaultValue: false,
    },
  ],
})
