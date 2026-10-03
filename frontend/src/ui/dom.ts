import sharedStyles from "../styles/globals.css" with { type: "text" }

export function ensureGlobalStyles(): void {
  if (document.getElementById("control-panel-global-styles")) {
    return
  }

  const style = document.createElement("style")
  style.id = "control-panel-global-styles"
  style.textContent = sharedStyles
  document.head.append(style)
}
