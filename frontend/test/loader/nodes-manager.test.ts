import { describe, expect, it } from "bun:test"

import {
  buildManagerQueuePayload,
  compareSemVer,
  filterAndSortManagedPacks,
  findHistoryItem,
  findInstalledPack,
  normalizeManagedPacks,
  safeImageUrl,
  safeHttpsUrl,
} from "../../src/services/nodesManager.ts"

describe("Nodes Manager service contracts", () => {
  it("uses jsDelivr for GitHub raw images while preserving repository URLs", () => {
    const raw =
      "https://raw.githubusercontent.com/crystian/ComfyUI-Crystools/main/docs/screwdriver.png"
    expect(safeImageUrl(raw)).toBe(
      "https://cdn.jsdelivr.net/gh/crystian/ComfyUI-Crystools@main/docs/screwdriver.png",
    )
    expect(
      safeImageUrl(
        "https://raw.githubusercontent.com/owner/repo/v1.2.0/image%20file.png?x=1#preview",
      ),
    ).toBe("https://cdn.jsdelivr.net/gh/owner/repo@v1.2.0/image%20file.png?x=1#preview")
    expect(safeHttpsUrl(raw)).toBe(raw)
    expect(safeImageUrl("https://example.com/image.png")).toBe("https://example.com/image.png")
    expect(
      safeImageUrl("http://raw.githubusercontent.com/owner/repo/main/image.png"),
    ).toBeUndefined()
    expect(safeImageUrl("invalid")).toBeUndefined()
  })
  it("prefers enabled copies and groups duplicate installed CNR identities", () => {
    const packs = normalizeManagedPacks(
      {
        nodes: [
          {
            id: "clip-proj",
            name: "Clip Proj",
            repository: "https://github.com/nicolab28/ComfyUI-ClipProj",
          },
        ],
      },
      {
        "ComfyUI-ClipProj": {
          cnr_id: "clip-proj",
          aux_id: "nicolab28/ComfyUI-ClipProj",
          ver: "abc123",
          enabled: false,
        },
        "ComfyUI-ClipProj-copy": {
          cnr_id: "clip-proj",
          aux_id: "nicolab28/ComfyUI-ClipProj",
          ver: "def456",
          enabled: true,
        },
      },
    )

    expect(packs).toHaveLength(1)
    expect(packs[0]?.installed).toMatchObject({ key: "ComfyUI-ClipProj-copy", enabled: true })
    expect(
      findInstalledPack(
        {
          "ComfyUI-ClipProj": { cnr_id: "clip-proj", enabled: false },
          "ComfyUI-ClipProj-copy": { cnr_id: "clip-proj", enabled: true },
        },
        packs[0]!,
      ),
    ).toMatchObject({ key: "ComfyUI-ClipProj-copy", enabled: true })
  })

  it("preserves unknown Git repository IDs while sorting with catalog metadata", () => {
    const packs = normalizeManagedPacks(
      {
        nodes: [
          { id: "small", name: "Small", stars: 1, last_update: "2025-01-01T00:00:00Z" },
          { id: "large", name: "Large", stars: 10, last_update: "2025-02-01T00:00:00Z" },
        ],
      },
      { folder: { aux_id: "owner/unknown-repo.git", ver: "abc", enabled: true } },
    )

    expect(packs.find((pack) => pack.isUnknown)).toMatchObject({
      id: "unknown-repo",
      managerNodeId: "unknown-repo",
      isUnknown: true,
    })
    expect(filterAndSortManagedPacks(packs, "all", "", "stars").map((pack) => pack.id)).toEqual([
      "large",
      "small",
      "unknown-repo",
    ])
    expect(filterAndSortManagedPacks(packs, "all", "", "updated").map((pack) => pack.id)).toEqual([
      "large",
      "small",
      "unknown-repo",
    ])
  })

  it("sorts by downloads descending and uses the name for ties or missing counts", () => {
    const packs = normalizeManagedPacks(
      {
        nodes: [
          { id: "low", name: "Low", downloads: 4 },
          { id: "tie-z", name: "Tie Z", downloads: 30 },
          { id: "high", name: "High", downloads: 30 },
          { id: "unknown", name: "Unknown" },
        ],
      },
      {},
    )

    expect(filterAndSortManagedPacks(packs, "all", "", "downloads").map((pack) => pack.id)).toEqual(
      ["high", "tie-z", "low", "unknown"],
    )
  })

  it("queues an exact Registry version without requiring optional repository metadata", () => {
    const [pack] = normalizeManagedPacks({ nodes: [{ id: "registry-pack", name: "Pack" }] }, {})
    const payload = buildManagerQueuePayload(pack!, "install", "client", "task", "1.2.3")

    expect(payload).toEqual({
      kind: "install",
      params: {
        id: "registry-pack",
        channel: "dev",
        mode: "cache",
        selected_version: "1.2.3",
        version: "1.2.3",
      },
      ui_id: "task",
      client_id: "client",
    })
    expect(payload.params.selected_version).toBe(payload.params.version)
  })

  it("uses canonical IDs and Manager-specific versions for registered and unknown Git tasks", () => {
    const [registered] = normalizeManagedPacks(
      {
        nodes: [
          { id: "cable-management", name: "Cable", repository: "https://github.com/example/cable" },
        ],
      },
      {
        "cable-management@1_0_1": {
          cnr_id: "cable-management",
          aux_id: "example/cable",
          ver: "commit-hash",
          enabled: false,
        },
      },
    )
    expect(buildManagerQueuePayload(registered!, "update", "client", "task").params).toEqual({
      node_name: "cable-management",
      node_ver: "nightly",
    })
    expect(buildManagerQueuePayload(registered!, "enable", "client", "task").params).toEqual({
      cnr_id: "cable-management",
    })
    expect(buildManagerQueuePayload(registered!, "disable", "client", "task").params).toEqual({
      node_name: "cable-management",
      is_unknown: false,
    })
    expect(buildManagerQueuePayload(registered!, "uninstall", "client", "task").params).toEqual({
      node_name: "cable-management",
      is_unknown: false,
    })

    const [unknown] = normalizeManagedPacks(
      { nodes: [] },
      { folder: { aux_id: "author/my-repo.git", ver: "commit-hash", enabled: true } },
    )
    expect(buildManagerQueuePayload(unknown!, "update", "client", "task").params).toEqual({
      node_name: "my-repo",
      node_ver: "unknown",
    })
    expect(buildManagerQueuePayload(unknown!, "uninstall", "client", "task").params).toEqual({
      node_name: "my-repo",
      is_unknown: true,
    })
  })

  it("compares SemVer and requires exact task and client identity in either history shape", () => {
    expect(compareSemVer("1.10.0", "1.2.0")).toBeGreaterThan(0)
    expect(compareSemVer("2.0.0-rc.1", "2.0.0")).toBeLessThan(0)
    expect(
      findHistoryItem(
        { ui_id: "task", client_id: "client", status: { status_str: "success", completed: true } },
        "task",
        "client",
      )?.status?.status_str,
    ).toBe("success")
    expect(
      findHistoryItem(
        {
          history: {
            first: { ui_id: "task", client_id: "other" },
            second: { ui_id: "task", client_id: "client" },
          },
        },
        "task",
        "client",
      )?.client_id,
    ).toBe("client")
    expect(findHistoryItem({ ui_id: "task", client_id: "other" }, "task", "client")).toBeUndefined()
  })
})
