import {
  createMetadataCache,
  normalizeMetadataString,
  resolveNodeMetadata,
  type MetadataNode,
} from "./cnrMetadata.ts"
import { collectGraphNodes, type MetadataGraph } from "./graphWalker.ts"
import { normalizeRepository, type InstalledPack, type ManagedPack } from "./nodesManager.ts"

type WorkflowOwner = {
  key: string
  token: string
  kind: "registry" | "repository" | "core" | "invalid"
  title?: string
  repository?: string
  metadataRepository?: string
}

type MappingEntry = {
  owner: WorkflowOwner
  nodeTypes: string[]
  preemptions: string[]
  pattern?: RegExp
}

export type WorkflowNodeDiagnostic = {
  type: string
  kind: "unresolved" | "ambiguous" | "unavailable"
  occurrences: number
  candidates?: string[]
}

export type WorkflowAnalysis = {
  packs: ManagedPack[]
  missingPacks: ManagedPack[]
  diagnostics: WorkflowNodeDiagnostic[]
  mappingIssueCount: number
}

type OwnerResolution =
  | { kind: "core" }
  | { kind: "resolved"; pack: ManagedPack }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unresolved"; candidates: string[] }

type NodeRuntimeMetadata = MetadataNode & {
  has_errors?: boolean
  isMissing?: boolean
  isVirtualNode?: boolean
  isSubgraphNode?: () => boolean
  subgraph?: unknown
}

const CORE_REPOSITORY = "comfyanonymous/comfyui"
const CORE_NODE_TYPES = new Set(["Note", "Reroute"])
const VIRTUAL_FRONTEND_TYPES = new Set(["MarkdownNote", "PrimitiveNode"])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const text = normalizeMetadataString(entry)
        return text ? [text] : []
      })
    : []
}

function ownerForKey(keyValue: unknown, metadata?: Record<string, unknown>): WorkflowOwner {
  const key = normalizeMetadataString(keyValue) ?? ""
  const repository = normalizeRepository(key)
  const title = normalizeMetadataString(metadata?.title)
  const lowerKey = key.toLocaleLowerCase()
  if (lowerKey === "comfy-core" || repository === CORE_REPOSITORY) {
    return { key, token: "core", kind: "core", title }
  }
  if (/^https?:\/\//iu.test(key) && !repository) {
    return { key, token: `invalid:${lowerKey}`, kind: "invalid", title }
  }
  if (repository) {
    return {
      key,
      token: `repo:${repository}`,
      kind: "repository",
      repository,
      title,
    }
  }
  if (key && !key.includes("/") && !key.includes(":")) {
    const metadataRepository = normalizeRepository(normalizeMetadataString(metadata?.repository))
    return {
      key,
      token: `cnr:${lowerKey}`,
      kind: "registry",
      title,
      ...(metadataRepository
        ? { metadataRepository: `https://github.com/${metadataRepository}` }
        : {}),
    }
  }
  return { key, token: `invalid:${lowerKey}`, kind: "invalid", title }
}

function parseMappings(value: unknown): { entries: MappingEntry[]; issueCount: number } {
  const root = asRecord(value)
  if (!root) return { entries: [], issueCount: 1 }
  const nested = asRecord(root.mappings)
  const mapping = nested ?? root
  const entries: MappingEntry[] = []
  let issueCount = 0

  for (const [key, rawEntry] of Object.entries(mapping)) {
    const pair = Array.isArray(rawEntry) ? rawEntry : undefined
    const metadata = asRecord(pair?.[1])
    if (!pair || !Array.isArray(pair[0]) || !metadata) {
      issueCount += 1
      continue
    }
    const nodeTypes = stringList(pair[0])
    const patternText = normalizeMetadataString(metadata.nodename_pattern)
    let pattern: RegExp | undefined
    let invalidEntry = false
    if (patternText) {
      try {
        pattern = new RegExp(patternText)
      } catch {
        invalidEntry = true
      }
    }
    const rawPreemptions = metadata.preemptions
    const preemptions = stringList(rawPreemptions)
    if (nodeTypes.length === 0 && !pattern && preemptions.length === 0) invalidEntry = true
    if (rawPreemptions !== undefined && !Array.isArray(rawPreemptions)) invalidEntry = true
    if (invalidEntry) issueCount += 1
    const owner = ownerForKey(key, metadata)
    entries.push({ owner, nodeTypes, preemptions })
    if (pattern) entries.push({ owner, nodeTypes: [], preemptions: [], pattern })
  }
  return { entries, issueCount }
}

function runtimePythonModule(node: MetadataNode): string | undefined {
  const nodeConstructor = (
    node as unknown as { constructor?: { nodeData?: { python_module?: unknown } } }
  ).constructor
  return normalizeMetadataString(nodeConstructor?.nodeData?.python_module)
}

function isSubgraphWrapper(node: NodeRuntimeMetadata): boolean {
  if (node.subgraph) return true
  try {
    if (node.isSubgraphNode?.()) return true
  } catch {
    // A malformed wrapper should still be handled by the regular ownership checks.
  }
  const type = normalizeMetadataString(node.type) ?? ""
  return type.startsWith("workflow/") || type.startsWith("workflow>")
}

function hasSavedCustomIdentity(node: MetadataNode): boolean {
  const properties = asRecord(node.properties)
  const cnrId = normalizeMetadataString(properties?.cnr_id)
  const auxId = normalizeMetadataString(properties?.aux_id)
  return Boolean(auxId || (cnrId && cnrId.toLocaleLowerCase() !== "comfy-core"))
}

function isFrontendOnlyNode(
  node: NodeRuntimeMetadata,
  type: string,
  runtime: ReturnType<typeof resolveNodeMetadata>,
): boolean {
  if (runtime.source === "custom" || hasSavedCustomIdentity(node)) return false
  if (node.has_errors === true && !runtimePythonModule(node)) return false
  if (CORE_NODE_TYPES.has(type)) return true
  return VIRTUAL_FRONTEND_TYPES.has(type) && node.isVirtualNode === true
}

function installedMetadata(installed: InstalledPack[]): Record<string, unknown> {
  return Object.fromEntries(
    installed.map((pack) => [
      pack.key,
      { cnr_id: pack.cnrId, aux_id: pack.auxId, ver: pack.version },
    ]),
  )
}

function packMatchesOwner(pack: ManagedPack, owner: WorkflowOwner): boolean {
  if (owner.kind === "registry") {
    return (
      pack.id.toLocaleLowerCase() === owner.key.toLocaleLowerCase() ||
      pack.installed?.cnrId?.toLocaleLowerCase() === owner.key.toLocaleLowerCase()
    )
  }
  if (owner.kind === "repository" && owner.repository) {
    return [pack.repository, pack.installed?.auxId]
      .map(normalizeRepository)
      .some((repository) => repository === owner.repository)
  }
  return false
}

function workflowOnlyPack(owner: WorkflowOwner): ManagedPack | undefined {
  if (owner.kind === "registry") {
    const id = owner.key
    return {
      key: `workflow:registry:${id.toLocaleLowerCase()}`,
      id,
      name: owner.title ?? id,
      repository: owner.metadataRepository,
      managerNodeId: id,
      isUnknown: false,
      source: "Registry",
      updateAvailable: false,
    }
  }
  if (owner.kind === "repository" && owner.repository) {
    const [account, repository] = owner.repository.split("/")
    const canonicalUrl = `https://github.com/${account}/${repository}`
    return {
      key: `workflow:repository:${owner.repository}`,
      id: owner.title ?? owner.repository,
      name: owner.title ?? repository ?? owner.repository,
      repository: canonicalUrl,
      managerNodeId: owner.key,
      isUnknown: true,
      readOnly: true,
      source: "Unknown",
      updateAvailable: false,
    }
  }
  return undefined
}

function resolveOwner(owner: WorkflowOwner, packs: ManagedPack[]): OwnerResolution {
  if (owner.kind === "core") return { kind: "core" }
  if (owner.kind === "invalid") return { kind: "unresolved", candidates: [owner.key || "?"] }

  let matches = packs.filter((pack) => packMatchesOwner(pack, owner))
  if (matches.length === 0 && owner.kind === "registry" && owner.metadataRepository) {
    matches = packs.filter(
      (pack) =>
        pack.installed !== undefined &&
        normalizeRepository(pack.installed.auxId) === normalizeRepository(owner.metadataRepository),
    )
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches.map((pack) => pack.name).toSorted() }
  }
  if (matches.length === 1) return { kind: "resolved", pack: matches[0]! }
  const synthetic = workflowOnlyPack(owner)
  return synthetic
    ? { kind: "resolved", pack: synthetic }
    : { kind: "unresolved", candidates: [owner.key || "?"] }
}

function dedupeOwners(owners: WorkflowOwner[]): WorkflowOwner[] {
  const unique = new Map<string, WorkflowOwner>()
  for (const owner of owners) {
    if (!unique.has(owner.token)) unique.set(owner.token, owner)
  }
  return [...unique.values()]
}

function isWorkflowOnlyPack(pack: ManagedPack): boolean {
  return pack.key.startsWith("workflow:")
}

function resolveOwnerSet(owners: WorkflowOwner[], packs: ManagedPack[]): OwnerResolution {
  const uniqueOwners = dedupeOwners(owners)
  if (uniqueOwners.length === 0) return { kind: "unresolved", candidates: [] }
  const resolutions = uniqueOwners.map((owner) => resolveOwner(owner, packs))
  if (resolutions.some((resolution) => resolution.kind === "core")) {
    return resolutions.length === 1
      ? { kind: "core" }
      : {
          kind: "ambiguous",
          candidates: uniqueOwners.map((owner) => owner.title ?? owner.key),
        }
  }
  const effectiveResolutions = [...resolutions]
  const registryAliases = new Map<string, number[]>()
  const repositoryAliases = new Map<string, number[]>()
  uniqueOwners.forEach((owner, index) => {
    if (owner.kind === "registry" && owner.metadataRepository) {
      const repository = normalizeRepository(owner.metadataRepository)
      if (repository)
        registryAliases.set(repository, [...(registryAliases.get(repository) ?? []), index])
    } else if (owner.kind === "repository" && owner.repository) {
      repositoryAliases.set(owner.repository, [
        ...(repositoryAliases.get(owner.repository) ?? []),
        index,
      ])
    }
  })
  for (const [repository, registryIndices] of registryAliases) {
    const repositoryIndices = repositoryAliases.get(repository) ?? []
    if (registryIndices.length !== 1 || repositoryIndices.length !== 1) continue
    const registryIndex = registryIndices[0]!
    const repositoryIndex = repositoryIndices[0]!
    const registryResolution = effectiveResolutions[registryIndex]
    const repositoryResolution = effectiveResolutions[repositoryIndex]
    if (registryResolution?.kind !== "resolved" || repositoryResolution?.kind !== "resolved") {
      continue
    }
    if (registryResolution.pack.key === repositoryResolution.pack.key) continue
    const registryOnly = isWorkflowOnlyPack(registryResolution.pack)
    const repositoryOnly = isWorkflowOnlyPack(repositoryResolution.pack)
    if (!registryOnly && !repositoryOnly) continue
    effectiveResolutions[registryIndex] = {
      kind: "resolved",
      pack: registryOnly && !repositoryOnly ? repositoryResolution.pack : registryResolution.pack,
    }
    effectiveResolutions[repositoryIndex] = { kind: "unresolved", candidates: [] }
  }
  const ambiguous = effectiveResolutions.flatMap((resolution) =>
    resolution.kind === "ambiguous" ? resolution.candidates : [],
  )
  if (ambiguous.length > 0) {
    return { kind: "ambiguous", candidates: [...new Set(ambiguous)].toSorted() }
  }
  const resolved = effectiveResolutions.flatMap((resolution) =>
    resolution.kind === "resolved" ? [resolution.pack] : [],
  )
  const unresolved = effectiveResolutions.flatMap((resolution) =>
    resolution.kind === "unresolved" ? resolution.candidates : [],
  )
  const packKeys = new Set(resolved.map((pack) => pack.key))
  if (packKeys.size > 1 || (resolved.length > 0 && unresolved.length > 0)) {
    return {
      kind: "ambiguous",
      candidates: [...new Set([...resolved.map((pack) => pack.name), ...unresolved])].toSorted(),
    }
  }
  if (packKeys.size === 1 && unresolved.length === 0) {
    return { kind: "resolved", pack: resolved[0]! }
  }
  if (unresolved.length > 0) {
    return { kind: "unresolved", candidates: [...new Set(unresolved)].toSorted() }
  }
  return { kind: "unresolved", candidates: [] }
}

function exactSavedOwners(node: MetadataNode): { owners: WorkflowOwner[]; core: boolean } {
  const properties = asRecord(node.properties)
  const cnrId = normalizeMetadataString(properties?.cnr_id)
  const auxId = normalizeMetadataString(properties?.aux_id)
  if (cnrId?.toLocaleLowerCase() === "comfy-core") return { owners: [], core: true }
  const owners = [
    ...(cnrId
      ? [{ key: cnrId, token: `cnr:${cnrId.toLocaleLowerCase()}`, kind: "registry" as const }]
      : []),
    ...(auxId
      ? [
          normalizeRepository(auxId)
            ? ownerForKey(auxId)
            : {
                key: auxId,
                token: `invalid:${auxId.toLocaleLowerCase()}`,
                kind: "invalid" as const,
              },
        ]
      : []),
  ]
  return { owners, core: false }
}

function diagnosticKey(diagnostic: WorkflowNodeDiagnostic): string {
  return `${diagnostic.kind}\0${diagnostic.type}\0${(diagnostic.candidates ?? []).join("\0")}`
}

function addDiagnostic(
  diagnostics: Map<string, WorkflowNodeDiagnostic>,
  type: string,
  kind: WorkflowNodeDiagnostic["kind"],
  candidates: string[] = [],
): void {
  const sortedCandidates = [...new Set(candidates.filter(Boolean))].toSorted()
  const diagnostic = {
    type,
    kind,
    occurrences: 1,
    ...(sortedCandidates.length ? { candidates: sortedCandidates } : {}),
  }
  const key = diagnosticKey(diagnostic)
  const previous = diagnostics.get(key)
  diagnostics.set(
    key,
    previous ? { ...previous, occurrences: previous.occurrences + 1 } : diagnostic,
  )
}

export function analyzeWorkflow(
  rootGraph: MetadataGraph,
  mappings: unknown,
  managedPacks: ManagedPack[],
  installed: InstalledPack[],
  installedKnown: boolean,
): WorkflowAnalysis {
  const { entries, issueCount: mappingIssueCount } = parseMappings(mappings)
  const exact = new Map<string, WorkflowOwner[]>()
  const preemptions = new Map<string, WorkflowOwner[]>()
  const patterns: { expression: RegExp; owner: WorkflowOwner }[] = []
  for (const entry of entries) {
    for (const type of entry.nodeTypes) {
      exact.set(type, [...(exact.get(type) ?? []), entry.owner])
    }
    for (const type of entry.preemptions) {
      preemptions.set(type, [...(preemptions.get(type) ?? []), entry.owner])
    }
    if (entry.pattern) patterns.push({ expression: entry.pattern, owner: entry.owner })
  }

  const cache = createMetadataCache(installedMetadata(installed))
  const resolvedPacks = new Map<string, ManagedPack>()
  const diagnostics = new Map<string, WorkflowNodeDiagnostic>()

  for (const node of collectGraphNodes(rootGraph)) {
    const runtimeNode = node as NodeRuntimeMetadata
    if (isSubgraphWrapper(runtimeNode)) continue
    const type = normalizeMetadataString(node.type) ?? "(unknown type)"
    const runtime = resolveNodeMetadata(node, cache)
    const unavailable =
      runtimeNode.isMissing === true ||
      (runtimeNode.has_errors === true && !runtimePythonModule(node))
    if (runtime.source === "core") continue
    if (isFrontendOnlyNode(runtimeNode, type, runtime)) {
      if (unavailable) addDiagnostic(diagnostics, type, "unavailable")
      continue
    }
    if (unavailable) addDiagnostic(diagnostics, type, "unavailable")

    if (runtime.source === "custom" && runtime.reason === "invalid-core-claim") {
      addDiagnostic(diagnostics, type, "unresolved", ["comfy-core"])
      continue
    }
    if (runtime.source === "custom" && runtime.reason === "ambiguous-key") {
      const owners = installed
        .filter((pack) => pack.key.toLocaleLowerCase() === runtime.packageKey?.toLocaleLowerCase())
        .flatMap((pack) => [pack.cnrId, pack.auxId])
        .filter((value): value is string => Boolean(value))
      addDiagnostic(diagnostics, type, "ambiguous", owners)
      continue
    }

    let resolution: OwnerResolution | undefined
    if (runtime.source === "custom" && (runtime.cnrId || runtime.auxId)) {
      resolution = resolveOwner(ownerForKey(runtime.cnrId ?? runtime.auxId), managedPacks)
    } else {
      const saved = exactSavedOwners(node)
      if (saved.core) continue
      const savedResolution = saved.owners.length
        ? resolveOwnerSet(saved.owners, managedPacks)
        : undefined
      if (savedResolution?.kind === "core") continue
      if (savedResolution?.kind === "ambiguous") {
        addDiagnostic(diagnostics, type, "ambiguous", savedResolution.candidates)
        continue
      }
      if (savedResolution?.kind === "resolved") {
        resolution = savedResolution
      }
      const preemptionOwners = preemptions.get(type) ?? []
      const exactOwners = exact.get(type) ?? []
      const mappedOwners = preemptionOwners.length
        ? preemptionOwners
        : exactOwners.some((owner) => owner.kind === "core")
          ? [ownerForKey("comfy-core")]
          : exactOwners
      const candidates = mappedOwners.length
        ? mappedOwners
        : patterns
            .filter(({ expression }) => {
              expression.lastIndex = 0
              return expression.test(type)
            })
            .map(({ owner }) => owner)
      if (!resolution) {
        const mappingResolution = candidates.length
          ? resolveOwnerSet(candidates, managedPacks)
          : undefined
        resolution =
          mappingResolution?.kind === "core"
            ? mappingResolution
            : (mappingResolution ?? savedResolution)
      }
    }

    if (!resolution || resolution.kind === "unresolved") {
      addDiagnostic(diagnostics, type, "unresolved", resolution?.candidates)
    } else if (resolution.kind === "ambiguous") {
      addDiagnostic(diagnostics, type, "ambiguous", resolution.candidates)
    } else if (resolution.kind === "resolved") {
      resolvedPacks.set(resolution.pack.key, resolution.pack)
    }
  }

  const packs = [...resolvedPacks.values()]
  return {
    packs,
    missingPacks: installedKnown ? packs.filter((pack) => !pack.installed) : [],
    diagnostics: [...diagnostics.values()].toSorted(
      (left, right) =>
        left.type.localeCompare(right.type, undefined, { sensitivity: "base" }) ||
        left.kind.localeCompare(right.kind),
    ),
    mappingIssueCount,
  }
}
