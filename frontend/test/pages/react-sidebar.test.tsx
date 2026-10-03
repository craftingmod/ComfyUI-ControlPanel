import { expect, it } from "bun:test"

import { createReactSidebar } from "@pages/react-sidebar.tsx"
import { act } from "react"

it("mounts interactive React UI and cleans up on replacement and destruction", async () => {
  const sidebar = createReactSidebar()
  if (sidebar.type !== "custom") throw new Error("Expected a custom DOM sidebar")
  const first = document.createElement("div")
  const second = document.createElement("div")
  const existingChild = document.createElement("span")
  first.append(existingChild)

  try {
    await act(async () => sidebar.render(first))
    expect(first.querySelector("button")?.textContent).toBe("Count: 0")
    const nativeNote = first.querySelector("[data-template-native-note]")
    expect(nativeNote?.closest("[data-template-theme]")).not.toBeNull()
    expect(first.querySelector("section")?.contains(nativeNote)).toBeFalse()
    await act(async () => first.querySelector("button")!.click())
    expect(first.querySelector("button")?.textContent).toBe("Count: 1")
    await act(async () => first.querySelectorAll("button")[1]!.click())
    expect(first.querySelector("button")?.textContent).toBe("Count: 0")

    await act(async () => sidebar.render(second))
    expect(first.childElementCount).toBe(1)
    expect(first.firstElementChild).toBe(existingChild)
    expect(first.querySelector("[data-template-native-note]")).toBeNull()
    expect(second.querySelector("button")?.textContent).toBe("Count: 0")
    await act(async () => sidebar.destroy?.())
    expect(second.childElementCount).toBe(0)
    await act(async () => sidebar.destroy?.())

    await act(async () => sidebar.render(second))
    expect(second.querySelector("button")?.textContent).toBe("Count: 0")
  } finally {
    await act(async () => sidebar.destroy?.())
  }
})
