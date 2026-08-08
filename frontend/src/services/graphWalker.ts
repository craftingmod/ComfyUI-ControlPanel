import type { MetadataNode } from "./cnrMetadata.ts"

export type MetadataGraph = {
  nodes?: MetadataNode[]
}

type SubgraphNode = MetadataNode & { subgraph?: MetadataGraph }

export function collectGraphNodes(rootGraph: MetadataGraph): MetadataNode[] {
  const nodes: MetadataNode[] = []
  const visitedNodes = new Set<MetadataNode>()
  const visitedGraphs = new Set<MetadataGraph>()

  function walk(graph: MetadataGraph): void {
    if (visitedGraphs.has(graph)) {
      return
    }
    visitedGraphs.add(graph)

    for (const node of graph.nodes ?? []) {
      if (!visitedNodes.has(node)) {
        visitedNodes.add(node)
        nodes.push(node)
      }
      const subgraph = (node as SubgraphNode).subgraph
      if (subgraph) {
        walk(subgraph)
      }
    }
  }

  walk(rootGraph)
  return nodes
}
