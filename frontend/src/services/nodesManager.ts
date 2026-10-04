import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import { API_ROUTES } from "../constants.ts"

export type RegistryVersion = {
  id?: string
  version: string
  status?: string
  status_reason?: unknown
  createdAt?: string
  deprecated?: boolean
  [key: string]: unknown
}

export type RegistryNode = {
  id: string
  name?: string
  author?: string
  publisher?: { name?: string }
  description?: string
  repository?: string
  icon?: string
  stars?: number
  github_stars?: number
  downloads?: number
  last_update?: string
  updatedAt?: string
  updated_at?: string
  created_at?: string
  latest_version?: RegistryVersion
  [key: string]: unknown
}

export type InstalledPack = {
  key: string
  cnrId?: string
  auxId?: string
  version?: string
  enabled?: boolean
}

export type ManagedPack = {
  key: string
  id: string
  name: string
  description: string
  author: string
  repository?: string
  icon?: string
  stars?: number
  downloads?: number
  updatedAt?: string
  latestVersion?: RegistryVersion
  installed?: InstalledPack
  managerNodeId: string
  isUnknown: boolean
  source: "Registry" | "Git" | "Unknown"
  updateAvailable: boolean
}

export type ManagerOperation = "install" | "switch" | "update" | "enable" | "disable" | "uninstall"
export type ManagerQueueKind = "install" | "update" | "enable" | "disable" | "uninstall"
export type ManagerQueuePayload = {
  kind: ManagerQueueKind
  params: Record<string, string | boolean>
  ui_id: string
  client_id: string
}

export type ManagerTaskHistory = {
  ui_id?: string
  client_id?: string
  kind?: string
  result?: string
  status?: {
    status_str?: string
    completed?: boolean
    messages?: string[]
  }
}

export type InstalledPacks = Record<
  string,
  {
    ver?: string
    cnr_id?: string
    aux_id?: string
    enabled?: boolean
  }
>

type JsonRecord = Record<string, unknown>

export class ManagerRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "ManagerRequestError"
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function repoKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  let pathname = value.trim()
  try {
    const url = new URL(pathname)
    if (url.hostname.toLowerCase() !== "github.com") return undefined
    pathname = url.pathname
  } catch {
    // Registry metadata may already contain owner/repository.
  }
  const parts = pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean)
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLocaleLowerCase() : undefined
}

function repositoryLeaf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const leaf = value.trim().replace(/\\/g, "/").split("/").filter(Boolean).at(-1)
  return leaf?.replace(/\.git$/i, "") || undefined
}

function parseSemVer(
  value: string | undefined,
): [number, number, number, (number | string)[]] | undefined {
  if (!value) return undefined
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    )
  if (!match) return undefined
  const prerelease = match[4]
  const parts = prerelease
    ? prerelease.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : []
  return [Number(match[1]), Number(match[2]), Number(match[3]), parts]
}

export function compareSemVer(left: string, right: string): number | undefined {
  const a = parseSemVer(left)
  const b = parseSemVer(right)
  if (!a || !b) return undefined
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  if (a[2] !== b[2]) return a[2] - b[2]
  const aPre = a[3]
  const bPre = b[3]
  if (aPre.length === 0 || bPre.length === 0) {
    return aPre.length === bPre.length ? 0 : aPre.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    if (aPre[index] === undefined || bPre[index] === undefined) {
      return aPre[index] === bPre[index] ? 0 : aPre[index] === undefined ? -1 : 1
    }
    if (aPre[index] === bPre[index]) continue
    if (typeof aPre[index] === "number" && typeof bPre[index] !== "number") return -1
    if (typeof aPre[index] !== "number" && typeof bPre[index] === "number") return 1
    return aPre[index] < bPre[index] ? -1 : 1
  }
  return 0
}

function normalizeInstalledPacks(value: unknown): InstalledPack[] {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const pack = asRecord(entry)
      const key = nonEmptyString(pack?.key)
      if (!pack || !key)
        throw new Error("Manager returned an invalid normalized installed-pack list.")
      return {
        key,
        cnrId: nonEmptyString(pack.cnrId),
        auxId: nonEmptyString(pack.auxId),
        version: nonEmptyString(pack.version),
        enabled: typeof pack.enabled === "boolean" ? pack.enabled : undefined,
      }
    })
  }
  const record = asRecord(value)
  if (!record) throw new Error("Manager installed-pack response was not a package map.")
  return Object.entries(record).map(([key, value]) => {
    const pack = asRecord(value)
    if (!pack) throw new Error(`Manager returned invalid installed-pack details for ${key}.`)
    return {
      key,
      cnrId: nonEmptyString(pack.cnr_id),
      auxId: nonEmptyString(pack.aux_id),
      version: nonEmptyString(pack.ver),
      enabled: typeof pack.enabled === "boolean" ? pack.enabled : undefined,
    }
  })
}

function installedIdentity(pack: InstalledPack): string {
  if (pack.cnrId) return `cnr:${pack.cnrId.toLocaleLowerCase()}`
  const repository = repoKey(pack.auxId)
  if (repository) return `repo:${repository}`
  return `key:${managerId(pack).toLocaleLowerCase()}`
}

function preferredInstalledPack(packs: InstalledPack[]): InstalledPack | undefined {
  return [...packs].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled === true ? -1 : 1
    return left.key.localeCompare(right.key, undefined, { sensitivity: "base" })
  })[0]
}

function groupInstalledPacks(packs: InstalledPack[]): InstalledPack[] {
  const groups = new Map<string, InstalledPack[]>()
  for (const pack of packs) {
    const identity = installedIdentity(pack)
    const group = groups.get(identity) ?? []
    group.push(pack)
    groups.set(identity, group)
  }
  return [...groups.values()].map((group) => preferredInstalledPack(group)!)
}

function catalogId(node: RegistryNode): string {
  return node.id || nonEmptyString(node.node_id) || ""
}

function matchInstalledPack(
  node: RegistryNode,
  installed: InstalledPack[],
): InstalledPack | undefined {
  const id = catalogId(node).toLocaleLowerCase()
  const cnrMatch = installed.find((pack) => pack.cnrId?.toLocaleLowerCase() === id)
  if (cnrMatch) return cnrMatch
  const keyMatch = installed.find((pack) => pack.key.toLocaleLowerCase() === id)
  if (keyMatch) return keyMatch
  const targetRepo = repoKey(nonEmptyString(node.repository))
  if (!targetRepo) return undefined
  const repoMatches = installed.filter((pack) => repoKey(pack.auxId) === targetRepo)
  return repoMatches.length === 1 ? repoMatches[0] : undefined
}

function managerId(pack: InstalledPack): string {
  return pack.cnrId ?? repositoryLeaf(pack.auxId) ?? pack.key
}

export function sameManagedPackTarget(left: ManagedPack, right: ManagedPack): boolean {
  const tokens = (pack: ManagedPack) =>
    new Set([
      `id:${pack.id.toLocaleLowerCase()}`,
      `manager:${pack.managerNodeId.toLocaleLowerCase()}`,
      ...[pack.repository, pack.installed?.auxId]
        .map(repoKey)
        .filter((value): value is string => Boolean(value))
        .map((value) => `repo:${value}`),
    ])
  const leftTokens = tokens(left)
  return [...tokens(right)].some((token) => leftTokens.has(token))
}

function packSource(pack: InstalledPack | undefined): ManagedPack["source"] {
  if (!pack) return "Registry"
  if (pack.cnrId) return pack.auxId ? "Git" : "Registry"
  return pack.auxId ? "Git" : "Unknown"
}

function makeManagedPack(
  node: RegistryNode | undefined,
  installed: InstalledPack | undefined,
): ManagedPack {
  const id = node ? catalogId(node) : managerId(installed!)
  const installedVersion = installed?.version
  const latestVersion = node?.latest_version
  const comparison = compareSemVer(installedVersion ?? "", latestVersion?.version ?? "")
  const source = packSource(installed)
  return {
    key: node ? `registry:${id}` : `installed:${installed!.key}`,
    id,
    name: nonEmptyString(node?.name) ?? id,
    description: nonEmptyString(node?.description) ?? "No description is available.",
    author:
      nonEmptyString(node?.author) ??
      nonEmptyString(node?.publisher?.name) ??
      (installed ? "Local installation" : "Unknown author"),
    repository: nonEmptyString(node?.repository),
    icon: nonEmptyString(node?.icon),
    stars:
      typeof node?.github_stars === "number"
        ? node.github_stars
        : typeof node?.stars === "number"
          ? node.stars
          : undefined,
    downloads: typeof node?.downloads === "number" ? node.downloads : undefined,
    updatedAt:
      nonEmptyString(node?.updated_at) ??
      nonEmptyString(node?.updatedAt) ??
      nonEmptyString(node?.last_update) ??
      nonEmptyString(latestVersion?.createdAt) ??
      nonEmptyString(latestVersion?.created_at),
    latestVersion,
    installed,
    managerNodeId: installed ? managerId(installed) : id,
    isUnknown: Boolean(installed && !installed.cnrId),
    source,
    updateAvailable: Boolean(
      installed?.cnrId && source === "Registry" && comparison !== undefined && comparison < 0,
    ),
  }
}

export function normalizeManagedPacks(
  catalogValue: unknown,
  installedValue: unknown,
): ManagedPack[] {
  const catalogRecord = asRecord(catalogValue)
  const rawNodes = catalogRecord?.nodes
  if (!Array.isArray(rawNodes))
    throw new Error("Cached Registry catalog did not contain a nodes list.")
  const catalog = rawNodes.filter((value): value is RegistryNode => {
    const node = asRecord(value)
    return Boolean(node && nonEmptyString(node.id ?? node.node_id))
  })
  const installed = groupInstalledPacks(normalizeInstalledPacks(installedValue))
  const packs = catalog.map((node) => {
    const match = matchInstalledPack(node, installed)
    return makeManagedPack(node, match)
  })
  const matchedIdentities = new Set(
    packs.flatMap((pack) => (pack.installed ? [installedIdentity(pack.installed)] : [])),
  )
  for (const pack of installed) {
    if (!matchedIdentities.has(installedIdentity(pack)))
      packs.push(makeManagedPack(undefined, pack))
  }
  return packs
}

export type NodesManagerFilter = "all" | "not-installed" | "installed" | "updates" | "disabled"
export type NodesManagerSort = "name" | "stars" | "updated" | "downloads"

export function filterAndSortManagedPacks(
  packs: ManagedPack[],
  filter: NodesManagerFilter,
  search: string,
  sort: NodesManagerSort,
): ManagedPack[] {
  const query = search.trim().toLocaleLowerCase()
  const filtered = packs.filter((pack) => {
    if (filter === "not-installed" && pack.installed) return false
    if (filter === "installed" && !pack.installed) return false
    if (filter === "updates" && !pack.updateAvailable) return false
    if (filter === "disabled" && (!pack.installed || pack.installed.enabled !== false)) return false
    if (!query) return true
    return [pack.name, pack.id, pack.author, pack.description].some((value) =>
      value.toLocaleLowerCase().includes(query),
    )
  })

  return filtered.sort((left, right) => {
    if (sort === "stars") {
      const starDelta = (right.stars ?? 0) - (left.stars ?? 0)
      if (starDelta !== 0) return starDelta
    }
    if (sort === "updated") {
      const leftTime = Date.parse(left.updatedAt ?? "") || 0
      const rightTime = Date.parse(right.updatedAt ?? "") || 0
      if (leftTime !== rightTime) return rightTime - leftTime
    }
    if (sort === "downloads") {
      const downloadDelta = (right.downloads ?? 0) - (left.downloads ?? 0)
      if (downloadDelta !== 0) return downloadDelta
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  })
}

export function safeImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

export function buildManagerQueuePayload(
  pack: ManagedPack,
  operation: ManagerOperation,
  clientId: string,
  taskId: string,
  selectedVersion?: string,
): ManagerQueuePayload {
  let kind: ManagerQueueKind
  let params: Record<string, string | boolean>
  if (operation === "install" || operation === "switch") {
    const exactVersion = selectedVersion?.trim()
    if (!exactVersion) {
      throw new Error("Select a Registry version before installing this pack.")
    }
    kind = "install"
    params = {
      id: pack.id,
      ...(pack.repository ? { repository: pack.repository } : {}),
      channel: "dev",
      mode: "cache",
      selected_version: exactVersion,
      version: exactVersion,
    }
  } else if (operation === "update") {
    kind = "update"
    const nodeVersion = pack.isUnknown
      ? "unknown"
      : pack.source === "Git"
        ? "nightly"
        : pack.installed?.version
    params = {
      node_name: pack.managerNodeId,
      ...(nodeVersion ? { node_ver: nodeVersion } : {}),
    }
  } else if (operation === "enable") {
    kind = "enable"
    params = { cnr_id: pack.managerNodeId }
  } else if (operation === "disable") {
    kind = "disable"
    params = { node_name: pack.managerNodeId, is_unknown: pack.isUnknown }
  } else {
    kind = "uninstall"
    params = { node_name: pack.managerNodeId, is_unknown: pack.isUnknown }
  }
  return { kind, params, ui_id: taskId, client_id: clientId }
}

export function findInstalledPack(
  installedValue: unknown,
  pack: ManagedPack,
): InstalledPack | undefined {
  const normalized =
    Array.isArray(installedValue) &&
    installedValue.every((value) => {
      const entry = asRecord(value)
      return entry && typeof entry.key === "string"
    })
      ? (installedValue as InstalledPack[])
      : normalizeInstalledPacks(installedValue)
  const match = normalized.filter(
    (installed) =>
      (pack.installed?.key && installed.key === pack.installed.key) ||
      (installed.cnrId && installed.cnrId.toLocaleLowerCase() === pack.id.toLocaleLowerCase()) ||
      installed.key.toLocaleLowerCase() === pack.id.toLocaleLowerCase() ||
      managerId(installed).toLocaleLowerCase() === pack.managerNodeId.toLocaleLowerCase(),
  )
  return preferredInstalledPack(match)
}

export function findHistoryItem(
  historyValue: unknown,
  taskId: string,
  clientId: string,
): ManagerTaskHistory | undefined {
  const response = asRecord(historyValue)
  if (!response) return undefined
  const history = asRecord(response.history) ?? response
  const direct = nonEmptyString(history.ui_id) ? (history as ManagerTaskHistory) : undefined
  const item =
    direct ??
    (Object.values(history)
      .map(asRecord)
      .find((candidate) => candidate?.ui_id === taskId && candidate.client_id === clientId) as
      | ManagerTaskHistory
      | undefined)
  return item?.ui_id === taskId && item.client_id === clientId ? item : undefined
}

export function createNodesManagerService(app: ComfyApp) {
  async function request(route: string, method = "GET", body?: unknown): Promise<JsonRecord> {
    let response: Response
    try {
      response = await app.api.fetchApi(route, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new ManagerRequestError(error instanceof Error ? error.message : String(error))
    }
    const text = await response.text()
    let data: JsonRecord = {}
    if (text.trim()) {
      try {
        const parsed: unknown = JSON.parse(text)
        data = asRecord(parsed) ?? {}
      } catch {
        const detail = text.trim() || response.statusText
        throw new ManagerRequestError(`HTTP ${response.status}: ${detail}`, response.status)
      }
    }
    if (!response.ok || data.ok === false) {
      const message =
        nonEmptyString(data.error) ??
        nonEmptyString(data.message) ??
        (response.status === 404 ? "ComfyUI-Manager v2 API is unavailable." : response.statusText)
      throw new ManagerRequestError(message, response.status)
    }
    return data
  }

  return {
    async loadCatalog() {
      const data = await request(API_ROUTES.NODES_MANAGER_CATALOG)
      if (!Array.isArray(data.nodes)) throw new Error("Nodes Manager catalog response was invalid.")
      return data as JsonRecord & { nodes: RegistryNode[]; source?: string; warning?: string }
    },
    async loadInstalled() {
      const data = await request("/v2/customnode/installed")
      return normalizeInstalledPacks(data)
    },
    async loadVersions(nodeId: string) {
      const query = new URLSearchParams({ node_id: nodeId })
      const data = await request(`${API_ROUTES.NODES_MANAGER_VERSIONS}?${query.toString()}`)
      if (!Array.isArray(data.versions)) throw new Error("Registry version response was invalid.")
      return data.versions.filter((value): value is RegistryVersion => {
        const version = asRecord(value)
        return Boolean(version && nonEmptyString(version.version))
      })
    },
    async enqueue(payload: ManagerQueuePayload) {
      await request("/v2/manager/queue/task", "POST", payload)
    },
    async startQueue() {
      await request("/v2/manager/queue/start", "POST", null)
    },
    async getTaskHistory(taskId: string, clientId: string) {
      const query = new URLSearchParams({ ui_id: taskId, client_id: clientId })
      return await request(`/v2/manager/queue/history?${query.toString()}`)
    },
  }
}

export type NodesManagerService = ReturnType<typeof createNodesManagerService>
