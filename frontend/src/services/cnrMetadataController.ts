import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import { collectGraphNodes, type MetadataGraph } from "./graphWalker.ts"
import {
  applyMetadataChange,
  CnrMetadataService,
  planMetadataChange,
  resolveNodeMetadata,
  type MetadataNode,
  type MetadataReason,
} from "./cnrMetadata.ts"

export type UnresolvedNode = {
  id?: number | string
  type?: string
  pythonModule?: string
  reason: MetadataReason
}

export type FixMetadataSummary = {
  updated: number
  alreadyCorrect: number
  unresolved: number
  skipped: number
  conflictsPreserved: number
  unresolvedNodes: UnresolvedNode[]
}

export type CnrMetadataController = {
  initialize: () => Promise<void>
  fillNode: (node: MetadataNode) => void
  fixActiveWorkflow: () => Promise<FixMetadataSummary | undefined>
}

type ChangeAwareGraph = MetadataGraph & {
  beforeChange?: () => void
  afterChange?: () => void
  setDirtyCanvas?: (foreground: boolean, background: boolean) => void
}

function formatSummary(summary: FixMetadataSummary): string {
  return [
    `Updated: ${summary.updated}`,
    `Already correct: ${summary.alreadyCorrect}`,
    `Unresolved: ${summary.unresolved}`,
    `Skipped: ${summary.skipped}`,
    `Conflicts preserved: ${summary.conflictsPreserved}`,
  ].join(" · ")
}

export function createCnrMetadataController(app: ComfyApp): CnrMetadataController {
  const service = new CnrMetadataService(app)
  const pendingNodes = new Set<MetadataNode>()
  let warnedAboutInitialization = false
  let warnedAboutConflict = false
  let initialization: Promise<void> | undefined

  function fillNode(node: MetadataNode): void {
    if (service.state === "idle" || service.state === "loading") {
      pendingNodes.add(node)
      return
    }
    const resolved = resolveNodeMetadata(node, service.cache)
    const plan = planMetadataChange(node, resolved, "fill-missing")
    applyMetadataChange(plan)
    if (plan.conflict && !warnedAboutConflict) {
      warnedAboutConflict = true
      console.warn("[ComfyUI-ControlPanel] Preserved conflicting workflow metadata", {
        nodeId: node.id,
        nodeType: node.type,
        pythonModule: resolved.pythonModule,
      })
    }
  }

  async function initializeOnce(): Promise<void> {
    const state = await service.refresh()
    if (state !== "ready" && !warnedAboutInitialization) {
      warnedAboutInitialization = true
      console.warn("[ComfyUI-ControlPanel] CNR metadata injection is running with incomplete API data.", service.lastErrors)
    }
    for (const node of pendingNodes) {
      fillNode(node)
    }
    pendingNodes.clear()
  }

  function initialize(): Promise<void> {
    initialization ??= initializeOnce()
    return initialization
  }

  async function fixActiveWorkflow(): Promise<FixMetadataSummary | undefined> {
    await initialize()
    const state = await service.refresh()
    if (state !== "ready") {
      app.extensionManager.toast.add({
        severity: "error",
        summary: "Repair Metadata",
        detail: `Metadata APIs are not fully available. ${service.lastErrors.join(" ")}`,
        life: 7000,
      })
      return undefined
    }

    const graph = app.graph as unknown as ChangeAwareGraph
    const plans = collectGraphNodes(graph).map((node) => {
      const resolved = resolveNodeMetadata(node, service.cache)
      return planMetadataChange(node, resolved, "repair")
    })
    const summary: FixMetadataSummary = {
      updated: 0,
      alreadyCorrect: 0,
      unresolved: 0,
      skipped: 0,
      conflictsPreserved: 0,
      unresolvedNodes: [],
    }

    for (const plan of plans) {
      if (plan.changed) {
        summary.updated += 1
      } else if (plan.conflict) {
        summary.conflictsPreserved += 1
      } else if (plan.resolved.reason && plan.resolved.source !== "unknown") {
        summary.unresolved += 1
        summary.unresolvedNodes.push({
          id: plan.node.id,
          type: plan.node.type,
          pythonModule: plan.resolved.pythonModule,
          reason: plan.resolved.reason,
        })
      } else if (plan.resolved.source === "unknown") {
        summary.skipped += 1
      } else {
        summary.alreadyCorrect += 1
      }
    }

    const changedPlans = plans.filter((plan) => plan.changed)
    if (changedPlans.length > 0) {
      graph.beforeChange?.()
      try {
        for (const plan of changedPlans) {
          applyMetadataChange(plan)
        }
        graph.setDirtyCanvas?.(true, true)
      } finally {
        graph.afterChange?.()
      }
    }

    app.extensionManager.toast.add({
      severity: summary.unresolved > 0 ? "warn" : "success",
      summary: "Repair Metadata",
      detail: formatSummary(summary),
      life: 7000,
    })
    return summary
  }

  return { initialize, fillNode, fixActiveWorkflow }
}
