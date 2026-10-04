import { describe, expect, it } from "bun:test"

import type { MetadataNode } from "../../src/services/cnrMetadata.ts"
import type { MetadataGraph } from "../../src/services/graphWalker.ts"
import { normalizeManagedPacks, type InstalledPack } from "../../src/services/nodesManager.ts"
import { analyzeWorkflow } from "../../src/services/nodesManagerWorkflow.ts"

type TestNode = MetadataNode & {
  has_errors?: boolean
  isMissing?: boolean
  isVirtualNode?: boolean
  subgraph?: MetadataGraph
}

function node(
  type: string,
  pythonModule?: string,
  properties?: Record<string, unknown>,
  extra: Partial<TestNode> = {},
): TestNode {
  class RuntimeNode {}
  if (pythonModule) {
    Object.defineProperty(RuntimeNode, "nodeData", { value: { python_module: pythonModule } })
  }
  return Object.assign(new RuntimeNode(), { type, properties, ...extra }) as TestNode
}

function installedPack(key: string, cnrId?: string, auxId?: string, enabled = true): InstalledPack {
  return { key, cnrId, auxId, version: "1.0.0", enabled }
}

function packs(nodes: unknown[], installed: InstalledPack[] = []) {
  return normalizeManagedPacks({ nodes }, installed)
}

function analyze(
  graph: MetadataGraph,
  mappings: unknown,
  managedPacks: ReturnType<typeof packs> = [],
  installed: InstalledPack[] = [],
  installedKnown = true,
) {
  return analyzeWorkflow(graph, mappings, managedPacks, installed, installedKnown)
}

describe("workflow Nodes Manager analysis", () => {
  it("prefers runtime package identity over stale saved metadata and mapping names", () => {
    const savedProperties = { cnr_id: "stale-pack", keep: 1 }
    const workflowNode = node("SharedNode", "custom_nodes.runtime-folder.nodes", savedProperties)
    const installed = [installedPack("runtime-folder", "runtime-pack")]
    const managed = packs(
      [
        { id: "runtime-pack", name: "Runtime Pack" },
        { id: "stale-pack", name: "Stale Pack" },
        { id: "mapped-pack", name: "Mapped Pack" },
      ],
      installed,
    )
    const before = structuredClone(savedProperties)

    const result = analyze(
      { nodes: [workflowNode] },
      { "mapped-pack": [["SharedNode"], {}] },
      managed,
      installed,
    )

    expect(result.packs.map((pack) => pack.id)).toEqual(["runtime-pack"])
    expect(result.missingPacks).toEqual([])
    expect(workflowNode.properties).toEqual(before)
  })

  it("joins saved Registry and Git identities to one owner before using ambiguous mappings", () => {
    const workflowNode = node("SavedNode", undefined, {
      cnr_id: "reference-pack",
      aux_id: "https://github.com/example/reference-pack.git",
    })
    const catalog = packs([
      {
        id: "reference-pack",
        name: "Reference Pack",
        repository: "https://github.com/example/reference-pack",
      },
    ])

    const result = analyze(
      { nodes: [workflowNode] },
      {
        "possible-owner-a": [["SavedNode"], {}],
        "possible-owner-b": [["SavedNode"], {}],
      },
      catalog,
    )

    expect(result.packs.map((pack) => pack.id)).toEqual(["reference-pack"])
    expect(result.diagnostics).toEqual([])
  })

  it("resolves Registry and repository keys, including regex-only patterns", () => {
    const installed = [installedPack("reference-folder", "reference-pack", "example/reference")]
    const managed = packs(
      [
        {
          id: "reference-pack",
          name: "Reference Pack",
          repository: "https://github.com/example/reference",
        },
      ],
      installed,
    )
    const result = analyze(
      {
        nodes: [
          node("ExactRegistry"),
          node("BothKeys"),
          node("ExactRepository"),
          node("Pattern/Only"),
        ],
      },
      {
        "reference-pack": [["ExactRegistry", "BothKeys"], {}],
        "https://github.com/example/reference.git": [["ExactRepository", "BothKeys"], {}],
        "pattern-pack": [[], { nodename_pattern: "^Pattern/" }],
      },
      managed,
      installed,
    )

    expect(result.packs.map((pack) => pack.id)).toEqual(["reference-pack", "pattern-pack"])
    expect(result.packs.find((pack) => pack.id === "reference-pack")?.installed?.enabled).toBe(true)
    expect(result.mappingIssueCount).toBe(0)
  })

  it("joins a Registry key with its explicit repository mapping when no local descriptor exists", () => {
    const result = analyze(
      { nodes: [node("AliasedNode")] },
      {
        "registry-pack": [["AliasedNode"], { repository: "https://github.com/owner/repo" }],
        "https://github.com/owner/repo.git": [["AliasedNode"], {}],
      },
    )

    expect(result.packs).toMatchObject([{ id: "registry-pack", source: "Registry" }])
    expect(result.diagnostics).toEqual([])
  })

  it("keeps a shared Registry repository ambiguous when multiple IDs claim it", () => {
    const repository = "https://github.com/owner/shared-repo"
    const result = analyze(
      { nodes: [node("AliasedNode")] },
      {
        "registry-pack-a": [["AliasedNode"], { repository }],
        "registry-pack-b": [["AliasedNode"], { repository }],
        [repository]: [["AliasedNode"], {}],
      },
    )

    expect(result.packs).toEqual([])
    expect(result.diagnostics).toMatchObject([
      {
        type: "AliasedNode",
        kind: "ambiguous",
        candidates: expect.arrayContaining(["registry-pack-a", "registry-pack-b"]),
      },
    ])
  })

  it("does not guess when exact mappings have multiple owners and keeps core exclusions", () => {
    const result = analyze(
      {
        nodes: [
          node("Ambiguous"),
          node("CoreNode"),
          node("CoreRuntime", "comfy_extras.nodes_upscale_model", { cnr_id: "fake-core-pack" }),
          node("Note"),
          node("Reroute"),
          node("workflow/wrapper", undefined, undefined, {
            subgraph: { nodes: [node("NestedCustom")] },
          }),
        ],
      },
      {
        "owner-a": [["Ambiguous"], {}],
        "owner-b": [["Ambiguous"], {}],
        "https://github.com/comfyanonymous/ComfyUI": [["CoreNode"], {}],
        "core-conflict": [["CoreNode"], {}],
        "fake-core-pack": [["CoreRuntime"], {}],
        "nested-pack": [["NestedCustom"], {}],
      },
    )

    expect(result.packs.map((pack) => pack.id)).toEqual(["nested-pack"])
    expect(result.diagnostics).toMatchObject([
      { type: "Ambiguous", kind: "ambiguous", candidates: ["owner-a", "owner-b"] },
    ])
  })

  it("excludes built-in virtual types before Manager fallback but keeps runtime custom lookalikes", () => {
    const installed = [installedPack("WJNodes", "wj-nodes-pack")]
    const managed = packs([{ id: "wj-nodes-pack", name: "WJNodes" }], installed)
    const mappings = {
      "https://github.com/807502278/ComfyUI-WJNodes": [["PrimitiveNode", "MarkdownNote"], {}],
    }
    const virtualOnly = analyze(
      {
        nodes: [
          node("PrimitiveNode", undefined, undefined, { isVirtualNode: true }),
          node("MarkdownNote", undefined, undefined, { isVirtualNode: true }),
          node("PrimitiveNode", undefined, undefined, {
            isVirtualNode: true,
            isMissing: true,
          }),
        ],
      },
      mappings,
      managed,
      installed,
    )
    const customLookalike = analyze(
      {
        nodes: [
          node("PrimitiveNode", "custom_nodes.WJNodes.nodes", undefined, {
            isVirtualNode: true,
          }),
        ],
      },
      mappings,
      managed,
      installed,
    )

    expect(virtualOnly.packs).toEqual([])
    expect(virtualOnly.diagnostics).toMatchObject([
      { type: "PrimitiveNode", kind: "unavailable", occurrences: 1 },
    ])
    expect(customLookalike.packs.map((pack) => pack.id)).toEqual(["wj-nodes-pack"])
    expect(customLookalike.diagnostics).toEqual([])
  })

  it("honors preemptions and falls back to regex mappings only after exact types", () => {
    const result = analyze(
      { nodes: [node("Claimed"), node("Fallback/Node")] },
      {
        "generic-owner": [["Claimed"], {}],
        "preferred-owner": [[], { preemptions: ["Claimed"] }],
        "regex-owner": [[], { nodename_pattern: "Fallback/" }],
        "exact-owner": [["Fallback/Node"], {}],
      },
    )

    expect(result.packs.map((pack) => pack.id)).toEqual(["preferred-owner", "exact-owner"])
    expect(result.mappingIssueCount).toBe(0)
  })

  it("uses Registry mapping repository metadata to find an installed Git descriptor", () => {
    const installed = [
      installedPack("git-folder", undefined, "https://github.com/example/git-pack.git", false),
    ]
    const managed = packs([], installed)
    const result = analyze(
      { nodes: [node("GitRuntimeNode")] },
      {
        "registry-pack": [
          ["GitRuntimeNode"],
          { repository: "https://github.com/example/git-pack", title: "Git Pack" },
        ],
      },
      managed,
      installed,
    )

    expect(result.packs).toEqual(managed)
    expect(result.packs[0]?.installed?.enabled).toBe(false)
    expect(result.missingPacks).toEqual([])
  })

  it("keeps an ambiguous runtime package key from being replaced by saved metadata", () => {
    const installed = [
      installedPack("Package", "first-pack"),
      installedPack("PACKAGE", "second-pack"),
    ]
    const managed = packs(
      [{ id: "first-pack" }, { id: "second-pack" }, { id: "saved-pack" }],
      installed,
    )
    const result = analyze(
      {
        nodes: [node("AmbiguousRuntime", "custom_nodes.package.nodes", { cnr_id: "saved-pack" })],
      },
      { "mapped-pack": [["AmbiguousRuntime"], {}] },
      managed,
      installed,
    )

    expect(result.packs).toEqual([])
    expect(result.diagnostics).toMatchObject([
      {
        type: "AmbiguousRuntime",
        kind: "ambiguous",
        candidates: expect.arrayContaining(["first-pack", "second-pack"]),
      },
    ])
  })

  it("retains unknown and missing-runtime diagnostics without treating disabled packs as missing", () => {
    const disabled = installedPack("disabled-folder", "disabled-pack", undefined, false)
    const managed = packs([{ id: "disabled-pack", name: "Disabled Pack" }], [disabled])
    const result = analyze(
      {
        nodes: [
          node("DisabledRuntimeNode", undefined, { cnr_id: "disabled-pack" }),
          node(
            "MissingRuntimeNode",
            undefined,
            { cnr_id: "disabled-pack" },
            {
              has_errors: true,
            },
          ),
          node("NoOwner"),
        ],
      },
      {},
      managed,
      [disabled],
    )

    expect(result.packs).toMatchObject([{ id: "disabled-pack", installed: { enabled: false } }])
    expect(result.diagnostics).toMatchObject([
      { type: "MissingRuntimeNode", kind: "unavailable" },
      { type: "NoOwner", kind: "unresolved" },
    ])
    expect(result.missingPacks).toEqual([])
  })

  it("reports absent workflow-only owners but leaves missing status unknown without installed data", () => {
    const graph = { nodes: [node("UnregisteredRepoNode")] }
    const mappings = {
      "https://github.com/example/no-registry-entry": [
        ["UnregisteredRepoNode"],
        { title: "No Registry Pack" },
      ],
    }
    const known = analyze(graph, mappings)
    const unknown = analyze(graph, mappings, [], [], false)

    expect(known.packs[0]).toMatchObject({
      name: "No Registry Pack",
      source: "Unknown",
      readOnly: true,
    })
    expect(known.missingPacks).toEqual(known.packs)
    expect(unknown.missingPacks).toEqual([])
  })

  it("handles nested, shared, and cyclic graphs while ignoring malformed entries and regexes", () => {
    const shared = { nodes: [node("NestedNode")] }
    const wrapper = node("SubgraphWrapper", undefined, undefined, { subgraph: shared })
    const root: MetadataGraph = { nodes: [wrapper, node("NestedNode")] }
    ;(shared.nodes![0] as TestNode).subgraph = root

    const result = analyze(root, {
      "nested-pack": [["NestedNode"], {}],
      "invalid-regex": [[], { nodename_pattern: "[" }],
      malformed: "bad-entry",
    })

    expect(result.packs.map((pack) => pack.id)).toEqual(["nested-pack"])
    expect(result.packs).toHaveLength(1)
    expect(result.mappingIssueCount).toBe(2)
  })
})
