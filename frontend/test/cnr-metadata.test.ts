import { describe, expect, it } from "vitest"
import {
  applyMetadataChange,
  createMetadataCache,
  normalizeMetadataString,
  planMetadataChange,
  resolveNodeMetadata,
  type MetadataNode,
} from "../src/services/cnrMetadata.ts"

function createNode(pythonModule?: string, properties?: Record<string, unknown>): MetadataNode {
  class TestNode {}
  if (pythonModule !== undefined) {
    Object.defineProperty(TestNode, "nodeData", {
      value: { python_module: pythonModule },
    })
  }
  return Object.assign(new TestNode(), { id: 7, type: "TestNode", properties }) as MetadataNode
}

describe("CNR metadata resolution", () => {
  it.each([
    "nodes",
    "nodes.image",
    "comfy_extras.nodes_upscale_model",
    "comfy_api_nodes.nodes_openai",
  ])("resolves %s as ComfyUI Core", (pythonModule) => {
    const result = resolveNodeMetadata(createNode(pythonModule), createMetadataCache({}, "0.31.1"))

    expect(result).toMatchObject({ source: "core", cnrId: "comfy-core", version: "0.31.1" })
  })

  it("uses the second custom_nodes module segment as the package key", () => {
    const cache = createMetadataCache({
      "anima-safe-pag": { cnr_id: "anima-safe-pag", ver: "0.1.0" },
    }, "0.31.1")

    expect(resolveNodeMetadata(createNode("custom_nodes.anima-safe-pag.nodes.image"), cache)).toMatchObject({
      source: "custom",
      packageKey: "anima-safe-pag",
      cnrId: "anima-safe-pag",
      version: "0.1.0",
    })
  })

  it("falls back to a case-insensitive package match", () => {
    const cache = createMetadataCache({ ComfyUI_KJNodes: { cnr_id: "kj-nodes" } }, "0.31.1")

    expect(resolveNodeMetadata(createNode("custom_nodes.comfyui_kjnodes.nodes"), cache).cnrId).toBe("kj-nodes")
  })

  it("rejects ambiguous case-insensitive package matches", () => {
    const cache = createMetadataCache({
      Package: { cnr_id: "first" },
      PACKAGE: { cnr_id: "second" },
    }, "0.31.1")

    expect(resolveNodeMetadata(createNode("custom_nodes.package.nodes"), cache).reason).toBe("ambiguous-key")
    expect(resolveNodeMetadata(createNode("custom_nodes.Package.nodes"), cache).cnrId).toBe("first")
  })

  it("prefers cnr_id over aux_id", () => {
    const cache = createMetadataCache({ pack: { cnr_id: "registry-pack", aux_id: "author/repo" } })

    const resolved = resolveNodeMetadata(createNode("custom_nodes.pack.nodes"), cache)

    expect(resolved.cnrId).toBe("registry-pack")
    expect(resolved.auxId).toBeUndefined()
  })

  it("uses aux_id when a registry ID is unavailable", () => {
    const cache = createMetadataCache({ pack: { cnr_id: null, aux_id: "author/repo", ver: " nightly " } })

    expect(resolveNodeMetadata(createNode("custom_nodes.pack.nodes"), cache)).toMatchObject({
      auxId: "author/repo",
      version: "nightly",
    })
  })

  it("rejects a custom package that claims the Core ID", () => {
    const cache = createMetadataCache({ pack: { cnr_id: "comfy-core" } })

    expect(resolveNodeMetadata(createNode("custom_nodes.pack.nodes"), cache).reason).toBe("invalid-core-claim")
  })

  it("skips nodes without python_module", () => {
    expect(resolveNodeMetadata(createNode(), createMetadataCache()).reason).toBe("missing-python-module")
  })

  it("only trims metadata strings", () => {
    expect(normalizeMetadataString("  v1+local.sha  ")).toBe("v1+local.sha")
    expect(normalizeMetadataString(42)).toBeUndefined()
  })
})

describe("CNR metadata change planning", () => {
  const resolved = {
    source: "custom" as const,
    cnrId: "expected-pack",
    version: "2.0.0",
  }

  it("fills missing metadata", () => {
    const node = createNode("custom_nodes.pack.nodes", { user_property: true })
    const plan = planMetadataChange(node, resolved, "fill-missing")
    applyMetadataChange(plan)

    expect(plan.changed).toBe(true)
    expect(node.properties).toEqual({ user_property: true, cnr_id: "expected-pack", ver: "2.0.0" })
  })

  it("preserves a different existing identifier in fill-missing mode", () => {
    const node = createNode("custom_nodes.pack.nodes", { cnr_id: "other-pack", ver: "old" })
    const plan = planMetadataChange(node, resolved, "fill-missing")
    applyMetadataChange(plan)

    expect(plan).toMatchObject({ changed: false, conflict: true })
    expect(node.properties).toEqual({ cnr_id: "other-pack", ver: "old" })
  })

  it("refreshes the version when the existing identifier matches", () => {
    const node = createNode("custom_nodes.pack.nodes", { cnr_id: "expected-pack", ver: "old" })
    const plan = planMetadataChange(node, resolved, "fill-missing")
    applyMetadataChange(plan)

    expect(plan).toMatchObject({ changed: true, conflict: false })
    expect(node.properties).toEqual({ cnr_id: "expected-pack", ver: "2.0.0" })
  })

  it("repairs identifiers and removes the opposite ID", () => {
    const node = createNode("custom_nodes.pack.nodes", { cnr_id: "wrong", aux_id: "old/repo", ver: "old", keep: 1 })
    const plan = planMetadataChange(node, resolved, "repair")
    applyMetadataChange(plan)

    expect(node.properties).toEqual({ cnr_id: "expected-pack", ver: "2.0.0", keep: 1 })
  })

  it("preserves unresolved metadata", () => {
    const node = createNode("custom_nodes.unknown.nodes", { cnr_id: "historical", ver: "old" })
    const unresolved = { source: "custom" as const, reason: "package-not-found" as const }
    const plan = planMetadataChange(node, unresolved, "repair")
    applyMetadataChange(plan)

    expect(plan.changed).toBe(false)
    expect(node.properties).toEqual({ cnr_id: "historical", ver: "old" })
  })

  it("is a no-op when metadata already matches", () => {
    const node = createNode("custom_nodes.pack.nodes", { cnr_id: "expected-pack", ver: "2.0.0" })

    expect(planMetadataChange(node, resolved, "repair").changed).toBe(false)
  })
})
