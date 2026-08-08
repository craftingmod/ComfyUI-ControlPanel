import { describe, expect, it, vi } from "vitest"
import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { createCnrMetadataController } from "../src/services/cnrMetadataController.ts"
import type { MetadataNode } from "../src/services/cnrMetadata.ts"

function createNode(pythonModule: string, properties?: Record<string, unknown>): MetadataNode {
  class TestNode {}
  Object.defineProperty(TestNode, "nodeData", { value: { python_module: pythonModule } })
  return Object.assign(new TestNode(), { id: 1, type: "TestNode", properties }) as MetadataNode
}

function createApp(options?: { managerStatus?: number }): {
  app: ComfyApp
  beforeChange: ReturnType<typeof vi.fn>
  afterChange: ReturnType<typeof vi.fn>
  setDirtyCanvas: ReturnType<typeof vi.fn>
  toast: ReturnType<typeof vi.fn>
  node: MetadataNode
} {
  const node = createNode("custom_nodes.pack.nodes")
  const beforeChange = vi.fn()
  const afterChange = vi.fn()
  const setDirtyCanvas = vi.fn()
  const toast = vi.fn()
  const app = {
    api: {
      fetchApi: vi.fn(async (route: string) => {
        if (route === "/v2/customnode/installed") {
          return new Response(JSON.stringify({ pack: { cnr_id: "registry-pack", ver: "1.2.3" } }), {
            status: options?.managerStatus ?? 200,
          })
        }
        if (route === "/customnode/installed") {
          return new Response("missing", { status: 404 })
        }
        return new Response(JSON.stringify({ system: { comfyui_version: "0.31.1" } }), { status: 200 })
      }),
    },
    graph: { nodes: [node], beforeChange, afterChange, setDirtyCanvas },
    extensionManager: { toast: { add: toast } },
  } as unknown as ComfyApp
  return { app, beforeChange, afterChange, setDirtyCanvas, toast, node }
}

describe("CNR metadata controller", () => {
  it("processes nodes queued while metadata is loading", async () => {
    const fixture = createApp()
    const controller = createCnrMetadataController(fixture.app)

    const initialization = controller.initialize()
    controller.fillNode(fixture.node)
    await initialization

    expect(fixture.node.properties).toMatchObject({ cnr_id: "registry-pack", ver: "1.2.3" })
  })

  it("repairs the graph as one undoable change", async () => {
    const fixture = createApp()
    const controller = createCnrMetadataController(fixture.app)

    const summary = await controller.fixActiveWorkflow()

    expect(summary).toMatchObject({ updated: 1, unresolved: 0, skipped: 0 })
    expect(fixture.node.properties).toMatchObject({ cnr_id: "registry-pack", ver: "1.2.3" })
    expect(fixture.beforeChange).toHaveBeenCalledTimes(1)
    expect(fixture.afterChange).toHaveBeenCalledTimes(1)
    expect(fixture.setDirtyCanvas).toHaveBeenCalledWith(true, true)
  })

  it("does not create another undo item when everything is already correct", async () => {
    const fixture = createApp()
    fixture.node.properties = { cnr_id: "registry-pack", ver: "1.2.3" }
    const controller = createCnrMetadataController(fixture.app)

    const summary = await controller.fixActiveWorkflow()

    expect(summary).toMatchObject({ updated: 0, alreadyCorrect: 1 })
    expect(fixture.beforeChange).not.toHaveBeenCalled()
    expect(fixture.afterChange).not.toHaveBeenCalled()
  })

  it("leaves the graph untouched when required APIs are unavailable", async () => {
    const fixture = createApp({ managerStatus: 500 })
    const controller = createCnrMetadataController(fixture.app)

    await expect(controller.fixActiveWorkflow()).resolves.toBeUndefined()
    expect(fixture.node.properties).toBeUndefined()
    expect(fixture.beforeChange).not.toHaveBeenCalled()
    expect(fixture.toast).toHaveBeenCalledWith(expect.objectContaining({ severity: "error" }))
  })
})
