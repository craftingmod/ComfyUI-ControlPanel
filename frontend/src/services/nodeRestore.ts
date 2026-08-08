import type { JsonObject } from "../types.ts"
import { createMetadataCache } from "./cnrMetadata.ts"

export type NodeRestoreManifest = JsonObject & {
  format_version: 1
  registry_nodes: Array<{ id: string }>
  git_nodes: Array<{ url: string, folder?: string }>
  unmanaged_nodes: Array<{ folder: string }>
}

function asRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function gitPath(normalized: string): string {
  if (normalized.includes(":") && !normalized.includes("://")) {
    return normalized.slice(normalized.lastIndexOf(":") + 1)
  }
  try {
    return new URL(normalized).pathname
  } catch {
    return normalized
  }
}

function inferredGitFolder(url: string): string | undefined {
  const normalized = url.trim().replace(/[\\/]+$/, "")
  const path = gitPath(normalized)
  const pathParts = path.split(/[\\/]/).filter(Boolean)
  const rawName = pathParts[pathParts.length - 1]?.replace(/\.git$/, "")
  return rawName?.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || undefined
}

export function buildNodeRestoreManifest(installedResponse: unknown, inventoryResponse: unknown): NodeRestoreManifest {
  const metadata = createMetadataCache(installedResponse)
  const rawNodes = asRecord(inventoryResponse)?.nodes
  const nodes = Array.isArray(rawNodes) ? rawNodes : []
  const registryNodes = new Map<string, { id: string }>()
  const gitNodes: Array<{ url: string, folder?: string }> = []
  const unmanagedNodes: Array<{ folder: string }> = []

  for (const rawNode of nodes) {
    const node = asRecord(rawNode)
    const folder = typeof node?.folder === "string" ? node.folder.trim() : ""
    if (!folder) {
      continue
    }
    const exactPack = metadata.exactPackages.get(folder)
    const lowercasePack = metadata.lowercasePackages.get(folder.toLowerCase())
    const pack = exactPack ?? (lowercasePack === null ? undefined : lowercasePack)
    if (pack?.cnrId) {
      registryNodes.set(pack.cnrId, { id: pack.cnrId })
      continue
    }

    const url = typeof node?.git_url === "string" ? node.git_url.trim() : ""
    if (url) {
      const gitNode: { url: string, folder?: string } = { url }
      if (folder !== inferredGitFolder(url)) {
        gitNode.folder = folder
      }
      gitNodes.push(gitNode)
    } else {
      unmanagedNodes.push({ folder })
    }
  }

  return {
    format_version: 1,
    registry_nodes: [...registryNodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    git_nodes: gitNodes.sort((left, right) => left.url.localeCompare(right.url)),
    unmanaged_nodes: unmanagedNodes.sort((left, right) => left.folder.localeCompare(right.folder)),
  }
}

export function parseNodeRestoreManifest(text: string): NodeRestoreManifest {
  const value: unknown = JSON.parse(text)
  const manifest = asRecord(value)
  if (
    manifest?.format_version !== 1
    || !Array.isArray(manifest.registry_nodes)
    || !Array.isArray(manifest.git_nodes)
  ) {
    throw new Error("This is not a supported node restore manifest.")
  }
  return {
    ...manifest,
    format_version: 1,
    registry_nodes: manifest.registry_nodes as Array<{ id: string }>,
    git_nodes: manifest.git_nodes as Array<{ url: string, folder?: string }>,
    unmanaged_nodes: Array.isArray(manifest.unmanaged_nodes)
      ? manifest.unmanaged_nodes as Array<{ folder: string }>
      : [],
  }
}

function displayCommandArgument(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value
}

export function dependencySyncNotice(result: unknown): string | undefined {
  const data = asRecord(result)
  if (data?.dependency_sync_required !== true) {
    return undefined
  }
  const command = Array.isArray(data.dependency_sync_command)
    ? data.dependency_sync_command.filter((part): part is string => typeof part === "string")
    : []
  const commandText = command.length > 0
    ? command.map(displayCommandArgument).join(" ")
    : "comfy node uv-sync"
  return `Close ComfyUI, then run: ${commandText}`
}
