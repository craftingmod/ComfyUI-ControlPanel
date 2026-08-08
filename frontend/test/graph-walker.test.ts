import { describe, expect, it } from "vitest"
import { collectGraphNodes, type MetadataGraph } from "../src/services/graphWalker.ts"
import type { MetadataNode } from "../src/services/cnrMetadata.ts"

describe("graph walker", () => {
  it("walks nested subgraphs once per node", () => {
    const child = { id: 2, type: "Child" }
    const shared = { id: 3, type: "Shared" }
    const nestedGraph: MetadataGraph = { nodes: [child, shared] }
    const parent = { id: 1, type: "Parent", subgraph: nestedGraph } as MetadataNode
    const root = { nodes: [parent, shared] }

    expect(collectGraphNodes(root).map((node) => node.id)).toEqual([1, 2, 3])
  })
})
