import { expect, it, vi } from "bun:test"

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"

import { Button } from "../../src/components/ui/button.tsx"

it("preserves native button refs and attributes while busy disables actions", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const ref = createRef<HTMLButtonElement>()
  const onClick = vi.fn()
  try {
    await act(async () =>
      root.render(
        <Button ref={ref} aria-label="Refresh catalog" aria-busy="true" onClick={onClick}>
          Refresh
        </Button>,
      ),
    )
    expect(ref.current).toBe(host.querySelector("button"))
    expect(ref.current?.type).toBe("button")
    expect(ref.current?.getAttribute("aria-busy")).toBe("true")
    await act(async () => ref.current?.click())
    expect(onClick).toHaveBeenCalledTimes(1)

    await act(async () =>
      root.render(
        <Button ref={ref} busy busyLabel="Refreshing…" onClick={onClick}>
          Refresh
        </Button>,
      ),
    )
    expect(ref.current?.disabled).toBe(true)
    expect(ref.current?.textContent).toBe("Refreshing…")
    await act(async () => ref.current?.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
