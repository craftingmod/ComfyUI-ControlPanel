import controlPanelStyles from "../styles.css?inline"

export function createButton(label: string, onClick: () => void, className = "cp-button"): HTMLButtonElement {
  const button = document.createElement("button")
  button.className = className
  button.type = "button"
  button.textContent = label
  button.addEventListener("click", onClick)
  return button
}

export function ensureStyles(): void {
  if (document.getElementById("control-panel-styles")) {
    return
  }

  const style = document.createElement("style")
  style.id = "control-panel-styles"
  style.textContent = controlPanelStyles
  document.head.append(style)
}
