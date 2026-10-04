import { describe, expect, it, vi } from "bun:test"

import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import { createTranslator } from "../../src/i18n/messages.ts"
import { restartWithManager } from "../../src/services/managerRestart.ts"

const t = createTranslator(() => "en")

function setup(responses: (Response | Error)[]) {
  const events = new EventTarget()
  const fetchApi = vi.fn(async (_route: string, _options: RequestInit) => {
    const response = responses.shift()
    if (response instanceof Error) throw response
    return response ?? new Response()
  })
  const api = Object.assign(events, { fetchApi })
  const app = { api } as unknown as ComfyApp
  const reconnect = () => {
    events.dispatchEvent(new Event("reconnecting"))
    events.dispatchEvent(new Event("reconnected"))
  }
  return { app, fetchApi, reconnect, events }
}

describe("Manager restart", () => {
  it("waits for reconnection and accepts an empty response", async () => {
    const { app, fetchApi, reconnect, events } = setup([new Response()])
    const remove = vi.spyOn(events, "removeEventListener")
    let completed = false
    const pending = restartWithManager(app, t).then(() => {
      completed = true
    })
    await Promise.resolve()
    events.dispatchEvent(new Event("reconnected"))
    expect(completed).toBe(false)
    reconnect()
    await pending
    expect(fetchApi.mock.calls[0]).toEqual([
      "/v2/manager/reboot",
      expect.objectContaining({ method: "POST", body: "{}" }),
    ])
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it("uses the legacy route only when v2 returns 404", async () => {
    const { app, fetchApi, reconnect } = setup([new Response(null, { status: 404 })])
    const pending = restartWithManager(app, t)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchApi.mock.calls.map((call) => call[0])).toEqual([
      "/v2/manager/reboot",
      "/manager/reboot",
    ])
    reconnect()
    await pending
  })

  it("reports a missing Manager", async () => {
    const { app } = setup([
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
    ])
    const error = await restartWithManager(app, t).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(t("error.managerRestartUnavailable"))
  })

  it("does not retry security denials or server errors", async () => {
    for (const status of [403, 500]) {
      const { app, fetchApi, events } = setup([new Response(null, { status })])
      const remove = vi.spyOn(events, "removeEventListener")
      const error = await restartWithManager(app, t).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(
        status === 403 ? t("error.managerRestartForbidden") : "HTTP 500",
      )
      expect(fetchApi).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledTimes(2)
    }
  })

  it("confirms a network disconnect through reconnection without a second POST", async () => {
    const { app, fetchApi, reconnect } = setup([new TypeError("Failed to fetch")])
    const pending = restartWithManager(app, t)
    await Promise.resolve()
    reconnect()
    await pending
    expect(fetchApi).toHaveBeenCalledTimes(1)
  })

  it("times out and cleans up when reconnection never arrives", async () => {
    const { app, events } = setup([new TypeError("Failed to fetch")])
    const remove = vi.spyOn(events, "removeEventListener")
    const original = globalThis.setTimeout
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementationOnce(((callback: () => void) =>
        original(callback, 0)) as typeof setTimeout)
    try {
      const error = await restartWithManager(app, t).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(t("error.restartReconnectTimeout"))
      expect(remove).toHaveBeenCalledTimes(2)
    } finally {
      timer.mockRestore()
    }
  })
})
