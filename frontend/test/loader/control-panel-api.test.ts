import { describe, expect, it, vi } from "bun:test"

import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import { createControlPanelApi } from "../../src/services/controlPanelApi.ts"

function createAppWithResponse(response: Response): ComfyApp {
  return {
    api: {
      fetchApi: vi.fn().mockResolvedValue(response),
    },
  } as unknown as ComfyApp
}

describe("control panel api", () => {
  it("returns parsed JSON responses", async () => {
    const app = createAppWithResponse(
      new Response(JSON.stringify({ ok: true, value: "ready" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    expect(await createControlPanelApi(app).fetchJson("/control-panel/status")).toEqual({
      ok: true,
      value: "ready",
    })
  })

  it("surfaces non-JSON responses with route and status details", async () => {
    const app = createAppWithResponse(
      new Response("404: Not Found", {
        status: 404,
        statusText: "Not Found",
      }),
    )

    const error = await createControlPanelApi(app)
      .fetchJson("/control-panel/missing")
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(
      "HTTP 404 for /control-panel/missing: 404: Not Found",
    )
  })
})
