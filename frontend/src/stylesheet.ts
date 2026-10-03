import { PROJECT_ID } from "./constants.ts"

export function installStylesheet(moduleUrl: string = import.meta.url): HTMLLinkElement {
  const id = `${PROJECT_ID}-stylesheet`
  const href = new URL("./index.css", moduleUrl).href
  const existing = document.getElementById(id)
  if (existing instanceof HTMLLinkElement) {
    existing.href = href
    return existing
  }

  const link = document.createElement("link")
  link.id = id
  link.rel = "stylesheet"
  link.href = href
  document.head.append(link)
  return link
}
