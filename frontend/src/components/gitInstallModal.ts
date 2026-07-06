import { API_ROUTES } from "../constants.ts"
import { createButton, ensureStyles } from "../ui/dom.ts"
import type { ToastSeverity } from "../types.ts"

type GitInstallModalOptions = {
  runOperation: (label: string, route: string, body?: Record<string, unknown>) => void
  toast: (severity: ToastSeverity, summary: string, detail: string) => void
}

export type GitInstallModalController = {
  open: () => void
  close: () => void
}

export function createGitInstallModalController(options: GitInstallModalOptions): GitInstallModalController {
  let gitInstallModalEl: HTMLElement | undefined
  let gitUrlInputEl: HTMLInputElement | undefined
  let gitNameInputEl: HTMLInputElement | undefined

  function close(): void {
    gitInstallModalEl?.remove()
  }

  function createGitInstallModal(): HTMLElement {
    ensureStyles()

    const backdrop = document.createElement("div")
    backdrop.className = "cp-backdrop"
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close()
      }
    })

    const panel = document.createElement("section")
    panel.className = "cp-panel cp-modal"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-modal", "true")
    panel.setAttribute("aria-labelledby", "cp-git-install-title")

    const header = document.createElement("div")
    header.className = "cp-header"

    const title = document.createElement("h2")
    title.id = "cp-git-install-title"
    title.className = "cp-title"
    title.textContent = "Install via Git URL"

    const closeButton = createButton("×", close, "cp-button cp-close")
    closeButton.setAttribute("aria-label", "Close")
    header.append(title, closeButton)

    const fields = document.createElement("div")
    fields.className = "cp-grid"

    const urlField = document.createElement("div")
    urlField.className = "cp-field cp-field-wide"
    const urlLabel = document.createElement("label")
    urlLabel.htmlFor = "cp-git-url"
    urlLabel.textContent = "Git URL"
    gitUrlInputEl = document.createElement("input")
    gitUrlInputEl.id = "cp-git-url"
    gitUrlInputEl.placeholder = "https://github.com/user/comfyui-node-pack.git"
    urlField.append(urlLabel, gitUrlInputEl)

    const nameField = document.createElement("div")
    nameField.className = "cp-field cp-field-wide"
    const nameLabel = document.createElement("label")
    nameLabel.htmlFor = "cp-folder-name"
    nameLabel.textContent = "Folder name"
    gitNameInputEl = document.createElement("input")
    gitNameInputEl.id = "cp-folder-name"
    gitNameInputEl.placeholder = "Optional"
    nameField.append(nameLabel, gitNameInputEl)
    fields.append(urlField, nameField)

    const actions = document.createElement("div")
    actions.className = "cp-modal-actions"
    actions.append(
      createButton("Cancel", close),
      createButton("Install", () => {
        const url = gitUrlInputEl?.value.trim() ?? ""
        const name = gitNameInputEl?.value.trim()
        if (!url) {
          options.toast("warn", "ComfyUI-ControlPanel", "Git URL is required.")
          gitUrlInputEl?.focus()
          return
        }
        close()
        options.runOperation("Install via Git URL", API_ROUTES.INSTALL_GIT_URL, { url, ...(name ? { name } : {}) })
      }),
    )

    panel.append(header, fields, actions)
    backdrop.append(panel)
    return backdrop
  }

  return {
    open(): void {
      if (!gitInstallModalEl) {
        gitInstallModalEl = createGitInstallModal()
      }
      if (!gitInstallModalEl.isConnected) {
        document.body.append(gitInstallModalEl)
      }
      gitUrlInputEl?.focus()
    },
    close,
  }
}
