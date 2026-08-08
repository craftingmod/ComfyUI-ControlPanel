import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

export type MetadataMode = "fill-missing" | "repair"
export type MetadataState = "idle" | "loading" | "ready" | "degraded" | "unavailable"
export type MetadataReason =
  | "ambiguous-key"
  | "core-version-unavailable"
  | "invalid-core-claim"
  | "missing-python-module"
  | "no-package-id"
  | "package-not-found"
  | "unsupported-module"

export type MetadataNode = {
  id?: number | string
  type?: string
  title?: string
  properties?: Record<string, unknown>
}

export type InstalledPack = {
  cnrId?: string
  auxId?: string
  version?: string
}

export type ResolvedMetadata = {
  source: "core" | "custom" | "unknown"
  pythonModule?: string
  packageKey?: string
  cnrId?: string
  auxId?: string
  version?: string
  reason?: MetadataReason
}

export type MetadataCache = {
  comfyCoreVersion?: string
  exactPackages: Map<string, InstalledPack>
  lowercasePackages: Map<string, InstalledPack | null>
}

export type MetadataChangePlan = {
  node: MetadataNode
  resolved: ResolvedMetadata
  changed: boolean
  conflict: boolean
  before: Record<string, unknown>
  after: Record<string, unknown>
}

type HttpError = Error & { status?: number }

const CORE_MODULES = new Set(["nodes", "comfy_extras", "comfy_api_nodes"])
const METADATA_KEYS = ["cnr_id", "aux_id", "ver"] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

export function normalizeMetadataString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const normalized = value.trim()
  return normalized || undefined
}

function pythonModuleForNode(node: MetadataNode): string | undefined {
  const nodeConstructor = (node as unknown as {
    constructor?: { nodeData?: { python_module?: unknown } }
  }).constructor
  return normalizeMetadataString(nodeConstructor?.nodeData?.python_module)
}

export function createMetadataCache(
  installedResponse?: unknown,
  comfyCoreVersion?: unknown,
): MetadataCache {
  const exactPackages = new Map<string, InstalledPack>()
  const lowercasePackages = new Map<string, InstalledPack | null>()
  const installed = asRecord(installedResponse)

  for (const [packageKey, rawPack] of Object.entries(installed ?? {})) {
    const packRecord = asRecord(rawPack)
    if (!packRecord) {
      continue
    }
    const pack: InstalledPack = {
      cnrId: normalizeMetadataString(packRecord.cnr_id),
      auxId: normalizeMetadataString(packRecord.aux_id),
      version: normalizeMetadataString(packRecord.ver),
    }
    exactPackages.set(packageKey, pack)

    const lowercaseKey = packageKey.toLowerCase()
    if (!lowercasePackages.has(lowercaseKey)) {
      lowercasePackages.set(lowercaseKey, pack)
    } else {
      lowercasePackages.set(lowercaseKey, null)
    }
  }

  return {
    comfyCoreVersion: normalizeMetadataString(comfyCoreVersion),
    exactPackages,
    lowercasePackages,
  }
}

export function resolveNodeMetadata(node: MetadataNode, cache: MetadataCache): ResolvedMetadata {
  const pythonModule = pythonModuleForNode(node)
  if (!pythonModule) {
    return { source: "unknown", reason: "missing-python-module" }
  }

  const [moduleType, packageKey] = pythonModule.split(".")
  if (CORE_MODULES.has(moduleType)) {
    if (!cache.comfyCoreVersion) {
      return { source: "core", pythonModule, reason: "core-version-unavailable" }
    }
    return {
      source: "core",
      pythonModule,
      cnrId: "comfy-core",
      version: cache.comfyCoreVersion,
    }
  }

  if (moduleType !== "custom_nodes" || !packageKey) {
    return { source: "unknown", pythonModule, reason: "unsupported-module" }
  }

  let pack = cache.exactPackages.get(packageKey)
  if (!pack) {
    const lowercasePack = cache.lowercasePackages.get(packageKey.toLowerCase())
    if (lowercasePack === null) {
      return { source: "custom", pythonModule, packageKey, reason: "ambiguous-key" }
    }
    pack = lowercasePack
  }

  if (!pack) {
    return { source: "custom", pythonModule, packageKey, reason: "package-not-found" }
  }
  if (pack.cnrId === "comfy-core") {
    return { source: "custom", pythonModule, packageKey, reason: "invalid-core-claim" }
  }
  if (pack.cnrId) {
    return {
      source: "custom",
      pythonModule,
      packageKey,
      cnrId: pack.cnrId,
      version: pack.version,
    }
  }
  if (pack.auxId) {
    return {
      source: "custom",
      pythonModule,
      packageKey,
      auxId: pack.auxId,
      version: pack.version,
    }
  }
  return { source: "custom", pythonModule, packageKey, reason: "no-package-id" }
}

function metadataChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return METADATA_KEYS.some((key) => before[key] !== after[key])
}

export function planMetadataChange(
  node: MetadataNode,
  resolved: ResolvedMetadata,
  mode: MetadataMode,
): MetadataChangePlan {
  const before = { ...(node.properties ?? {}) }
  const after = { ...before }

  if (resolved.reason || (!resolved.cnrId && !resolved.auxId)) {
    return { node, resolved, changed: false, conflict: false, before, after }
  }

  const desiredKey = resolved.cnrId ? "cnr_id" : "aux_id"
  const oppositeKey = desiredKey === "cnr_id" ? "aux_id" : "cnr_id"
  const desiredId = resolved.cnrId ?? resolved.auxId

  if (mode === "repair") {
    after[desiredKey] = desiredId
    delete after[oppositeKey]
    if (resolved.version) {
      after.ver = resolved.version
    }
    return {
      node,
      resolved,
      changed: metadataChanged(before, after),
      conflict: false,
      before,
      after,
    }
  }

  const currentDesiredId = normalizeMetadataString(before[desiredKey])
  const currentOppositeId = normalizeMetadataString(before[oppositeKey])
  const conflict = Boolean(
    currentOppositeId
    || (currentDesiredId && currentDesiredId !== desiredId),
  )
  if (conflict) {
    return { node, resolved, changed: false, conflict: true, before, after }
  }

  if (!currentDesiredId) {
    after[desiredKey] = desiredId
  }
  if (resolved.version && before.ver !== resolved.version) {
    after.ver = resolved.version
  }

  return {
    node,
    resolved,
    changed: metadataChanged(before, after),
    conflict: false,
    before,
    after,
  }
}

export function applyMetadataChange(plan: MetadataChangePlan): void {
  if (!plan.changed) {
    return
  }
  const properties = (plan.node.properties ??= {})
  for (const key of METADATA_KEYS) {
    if (key in plan.after) {
      properties[key] = plan.after[key]
    } else {
      delete properties[key]
    }
  }
}

async function fetchJson(app: ComfyApp, route: string): Promise<unknown> {
  const response = await app.api.fetchApi(route)
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} for ${route}`) as HttpError
    error.status = response.status
    throw error
  }
  return await response.json() as unknown
}

export async function fetchInstalledPackages(app: ComfyApp): Promise<unknown> {
  try {
    return await fetchJson(app, "/v2/customnode/installed")
  } catch (error) {
    if ((error as HttpError).status !== 404) {
      throw error
    }
    return await fetchJson(app, "/customnode/installed")
  }
}

function coreVersionFromResponse(value: unknown): string | undefined {
  return normalizeMetadataString(asRecord(asRecord(value)?.system)?.comfyui_version)
}

export class CnrMetadataService {
  state: MetadataState = "idle"
  cache: MetadataCache = createMetadataCache()
  lastErrors: string[] = []

  constructor(private readonly app: ComfyApp) {}

  async refresh(): Promise<MetadataState> {
    this.state = "loading"
    this.lastErrors = []

    const [installedResult, systemResult] = await Promise.allSettled([
      fetchInstalledPackages(this.app),
      fetchJson(this.app, "/system_stats"),
    ])
    const installed = installedResult.status === "fulfilled" ? installedResult.value : undefined
    const coreVersion = systemResult.status === "fulfilled"
      ? coreVersionFromResponse(systemResult.value)
      : undefined

    if (installedResult.status === "rejected") {
      this.lastErrors.push(`Manager installed-pack API: ${String(installedResult.reason)}`)
    }
    if (systemResult.status === "rejected") {
      this.lastErrors.push(`ComfyUI system stats API: ${String(systemResult.reason)}`)
    } else if (!coreVersion) {
      this.lastErrors.push("ComfyUI system stats API did not return system.comfyui_version")
    }

    this.cache = createMetadataCache(installed, coreVersion)
    const managerReady = installedResult.status === "fulfilled"
    const coreReady = Boolean(coreVersion)
    this.state = managerReady && coreReady
      ? "ready"
      : managerReady || coreReady
        ? "degraded"
        : "unavailable"
    return this.state
  }
}
