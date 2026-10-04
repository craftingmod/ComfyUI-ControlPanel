import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import { createTranslator } from "../i18n/messages.ts"
import {
  applyMetadataChange,
  CnrMetadataService,
  planMetadataChange,
  resolveNodeMetadata,
  type MetadataNode,
  type MetadataReason,
} from "./cnrMetadata.ts"
import { collectGraphNodes, type MetadataGraph } from "./graphWalker.ts"

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

export function createCnrMetadataController(app: ComfyApp): CnrMetadataController {
  const service = new CnrMetadataService(app)
  const t = createTranslator(() => app.extensionManager.setting?.get?.("Comfy.Locale"))
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
      console.warn(
        "[ComfyUI-ControlPanel] CNR metadata injection is running with incomplete API data.",
        service.lastErrors,
      )
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
        summary: t("command.repairMetadata"),
        detail: t("metadata.apiUnavailable", { error: service.lastErrors.join(" ") }),
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
      summary: t("command.repairMetadata"),
      detail: t("metadata.summary", {
        updated: summary.updated,
        alreadyCorrect: summary.alreadyCorrect,
        unresolved: summary.unresolved,
        skipped: summary.skipped,
        conflictsPreserved: summary.conflictsPreserved,
      }),
      life: 7000,
    })
    return summary
  }

  return { initialize, fillNode, fixActiveWorkflow }
}
