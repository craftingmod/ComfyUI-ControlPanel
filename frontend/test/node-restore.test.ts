import { describe, expect, it } from "vitest"
import { buildNodeRestoreManifest, dependencySyncNotice, parseNodeRestoreManifest } from "../src/services/nodeRestore.ts"

describe("node restore manifests", () => {
  it("prefers registry ids and omits default Git folder names", () => {
    const manifest = buildNodeRestoreManifest(
      {
        RegistryFolder: { cnr_id: "registry-node", ver: "1.2.3" },
        GitFolder: { aux_id: "author/GitFolder" },
      },
      {
        nodes: [
          { folder: "RegistryFolder", git_url: "https://github.com/author/registry-repo.git" },
          { folder: "GitFolder", git_url: "https://github.com/author/GitFolder.git" },
          { folder: "RenamedFolder", git_url: "https://github.com/author/original-name.git" },
          { folder: "LocalOnly" },
        ],
      },
    )

    expect(manifest).toEqual({
      format_version: 1,
      registry_nodes: [{ id: "registry-node" }],
      git_nodes: [
        { url: "https://github.com/author/GitFolder.git" },
        { url: "https://github.com/author/original-name.git", folder: "RenamedFolder" },
      ],
      unmanaged_nodes: [{ folder: "LocalOnly" }],
    })
  })

  it("accepts manifests without unmanaged_nodes", () => {
    expect(parseNodeRestoreManifest(JSON.stringify({
      format_version: 1,
      registry_nodes: [{ id: "registry-node" }],
      git_nodes: [],
    }))).toMatchObject({ unmanaged_nodes: [] })
  })

  it("rejects unsupported JSON payloads", () => {
    expect(() => parseNodeRestoreManifest("[]")).toThrow("supported node restore manifest")
  })

  it("formats the required post-restore dependency sync command", () => {
    expect(dependencySyncNotice({
      dependency_sync_required: true,
      dependency_sync_command: ["comfy", "--workspace", "C:/Comfy UI", "node", "uv-sync"],
    })).toBe('Close ComfyUI, then run: comfy --workspace "C:/Comfy UI" node uv-sync')
    expect(dependencySyncNotice({ dependency_sync_required: false })).toBeUndefined()
  })
})
