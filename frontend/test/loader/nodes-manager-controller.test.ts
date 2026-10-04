import { describe, expect, it } from "bun:test"

import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import type { MetadataGraph } from "../../src/services/graphWalker.ts"
import type {
  ManagerQueuePayload,
  RegistryNode,
  RegistryVersion,
} from "../../src/services/nodesManager.ts"
import { createNodesManagerController } from "../../src/services/nodesManagerController.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function workflowNode(type: string, pythonModule?: string) {
  class RuntimeNode {}
  if (pythonModule) {
    Object.defineProperty(RuntimeNode, "nodeData", { value: { python_module: pythonModule } })
  }
  return Object.assign(new RuntimeNode(), { type })
}

type FixtureOptions = {
  localPacks?: unknown[]
  catalog?: RegistryNode[]
  gitJobStatus?: "running" | "succeeded"
  confirm?: (options: { title: string; message: string }) => Promise<boolean>
  failEnqueue?: boolean
  failStarts?: number
  history?: (taskId: string, clientId: string) => unknown
  installed?: Record<string, unknown>
  installedRead?: (read: number) => Promise<Response> | Response
  onEnqueue?: (payload: ManagerQueuePayload) => void
  catalogAvailable?: boolean
  loadVersions?: () => Promise<Response>
  workflowGraph?: MetadataGraph
  mappings?: unknown
  mappingResponse?: (route: string, read: number) => Promise<Response> | Response
}

function createFixture(options: FixtureOptions = {}) {
  let installed = options.installed ?? {}
  let startFailures = options.failStarts ?? 0
  let catalogAvailable = options.catalogAvailable ?? true
  let installedReads = 0
  let workflowGraph = options.workflowGraph ?? { nodes: [] }
  let mappingReads = 0
  const requests: { route: string; method: string; body?: unknown }[] = []
  const signals: AbortSignal[] = []
  const toasts: unknown[] = []
  const confirms: { title: string; message: string }[] = []
  let enqueueCount = 0
  let startCount = 0
  const app = {
    api: {
      clientId: "client-test",
      fetchApi: async (route: string, init?: RequestInit) => {
        const method = init?.method ?? "GET"
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        requests.push({ route, method, body })
        if (init?.signal) signals.push(init.signal)
        if (route === "/control-panel/nodes-manager/catalog") {
          if (!catalogAvailable)
            return new Response(JSON.stringify({ error: "cache missing" }), { status: 503 })
          return new Response(
            JSON.stringify({
              nodes: options.catalog ?? [
                {
                  id: "pack-id",
                  name: "Pack Name",
                  repository: "https://github.com/owner/pack",
                  latest_version: { version: "1.2.3" },
                },
              ],
              source: "sqlite",
            }),
          )
        }
        if (route === "/control-panel/nodes-manager/versions?node_id=pack-id") {
          return (
            options.loadVersions?.() ??
            new Response(JSON.stringify({ versions: [{ version: "1.2.3" }] }))
          )
        }
        if (route === "/v2/customnode/installed") {
          installedReads += 1
          if (options.installedRead) return options.installedRead(installedReads)
          return new Response(JSON.stringify(installed))
        }
        if (route === "/control-panel/nodes-manager/local-folders") {
          return new Response(JSON.stringify({ packs: options.localPacks ?? [] }))
        }
        if (route === "/control-panel/nodes-manager/open-folder") {
          return new Response(JSON.stringify({ ok: true }))
        }
        if (
          route === "/control-panel/update/git-node" ||
          route.startsWith("/control-panel/update/jobs/")
        ) {
          return new Response(
            JSON.stringify({
              job: {
                id:
                  route === "/control-panel/update/git-node"
                    ? body.node_key
                    : route.split("/").at(-1),
                label: "Git update",
                status: options.gitJobStatus ?? "succeeded",
                logs: [],
              },
            }),
          )
        }
        if (
          route === "/v2/customnode/getmappings?mode=local" ||
          route === "/customnode/getmappings?mode=local"
        ) {
          mappingReads += 1
          return (
            options.mappingResponse?.(route, mappingReads) ??
            new Response(JSON.stringify(options.mappings ?? {}))
          )
        }
        if (route === "/v2/manager/queue/task") {
          enqueueCount += 1
          if (options.failEnqueue) throw new Error("connection lost")
          options.onEnqueue?.(body as ManagerQueuePayload)
          return new Response("", { status: 200 })
        }
        if (route === "/v2/manager/queue/start") {
          startCount += 1
          if (startFailures > 0) {
            startFailures -= 1
            return new Response(JSON.stringify({ error: "queue start failed" }), { status: 500 })
          }
          return new Response("", { status: 200 })
        }
        if (route.startsWith("/v2/manager/queue/history?")) {
          const query = new URLSearchParams(route.split("?")[1])
          const taskId = query.get("ui_id") ?? ""
          const clientId = query.get("client_id") ?? ""
          return new Response(
            JSON.stringify(options.history?.(taskId, clientId) ?? { history: {} }),
          )
        }
        return new Response(JSON.stringify({ error: `Unexpected route ${route}` }), { status: 404 })
      },
    },
    get rootGraph() {
      return workflowGraph
    },
    extensionManager: {
      toast: { add: (toast: unknown) => toasts.push(toast) },
      dialog: {
        confirm: async (value: { title: string; message: string }) => {
          confirms.push(value)
          return options.confirm ? options.confirm(value) : true
        },
      },
    },
  } as unknown as ComfyApp
  const controller = createNodesManagerController(app)
  return {
    controller,
    requests,
    signals,
    toasts,
    confirms,
    setInstalled: (value: Record<string, unknown>) => {
      installed = value
    },
    setCatalogAvailable: (value: boolean) => {
      catalogAvailable = value
    },
    setWorkflow: (value: MetadataGraph) => {
      workflowGraph = value
    },
    counts: () => ({ enqueueCount, startCount }),
  }
}

describe("Nodes Manager controller", () => {
  it("passes only the local folder name to Browse without queueing Manager operations", async () => {
    const key = "V:/custom_nodes/local pack"
    const fixture = createFixture({
      localPacks: [{ key, name: "local pack", local: true, enabled: true }],
    })
    await fixture.controller.open()
    const packs = fixture.controller.getSnapshot().packs
    await fixture.controller.browseLocalFolder(
      packs.find((pack) => pack.source === "Local folder")!,
    )
    await fixture.controller.browseLocalFolder(packs.find((pack) => pack.source === "Registry")!)
    expect(
      fixture.requests.filter(
        (request) => request.route === "/control-panel/nodes-manager/open-folder",
      ),
    ).toMatchObject([{ method: "POST", body: { node_id: "local pack" } }])
    expect(fixture.counts().enqueueCount).toBe(0)
    fixture.controller.close()
  })

  it("fetches each Git target once and stops waiting batches when the dialog closes", async () => {
    for (const status of ["succeeded", "running"] as const) {
      const fixture = createFixture({
        gitJobStatus: status,
        installed: {
          first: { aux_id: "owner/first", enabled: true },
          second: { aux_id: "owner/second", enabled: true },
          registry: { cnr_id: "registry", enabled: true },
        },
      })
      await fixture.controller.open()
      const batch = fixture.controller.submitAll("git")
      if (status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(fixture.controller.getSnapshot().bulkOperation).toBe("git")
        await fixture.controller.submitAll("git")
        fixture.controller.close()
      }
      await batch
      const targets = fixture.requests.filter(
        (request) => request.route === "/control-panel/update/git-node",
      )
      expect(targets.map((request) => request.body)).toEqual(
        status === "running"
          ? [{ node_key: "first" }]
          : [{ node_key: "first" }, { node_key: "second" }],
      )
      expect(fixture.controller.getSnapshot().bulkOperation).toBeUndefined()
      fixture.controller.close()
    }
  })

  it("updates only Registry packs with newer versions through the existing queue", async () => {
    const fixture = createFixture({
      catalog: ["first", "second", "current"].map((id) => ({
        id,
        latest_version: { version: "2.0.0" },
      })),
      installed: {
        first: { cnr_id: "first", ver: "1.0.0", enabled: true },
        second: { cnr_id: "second", ver: "1.0.0", enabled: true },
        current: { cnr_id: "current", ver: "2.0.0", enabled: true },
        git: { aux_id: "owner/git", enabled: true },
      },
      history: (ui_id, client_id) => ({
        history: { ui_id, client_id, status: { completed: true, status_str: "success" } },
      }),
    })
    await fixture.controller.open()
    await fixture.controller.submitAll("updates")
    const tasks = fixture.requests.filter((request) => request.route === "/v2/manager/queue/task")
    expect(tasks.map((request) => (request.body as ManagerQueuePayload).params.node_name)).toEqual([
      "first",
      "second",
    ])
    expect(fixture.controller.getSnapshot().bulkOperation).toBeUndefined()
    expect(
      fixture.toasts.filter((toast) => (toast as { severity: string }).severity === "success"),
    ).toEqual([
      {
        severity: "success",
        summary: "Nodes Manager",
        detail: "Update All completed.",
        life: 5000,
      },
    ])
    fixture.controller.close()
  })

  it("does not announce bulk success for failed, skipped, uncertain, empty, or closed batches", async () => {
    for (const status of ["error", "skip", "uncertain", "empty", "closed"] as const) {
      const historySeen = deferred<void>()
      const fixture = createFixture({
        installed:
          status === "empty" ? {} : { folder: { cnr_id: "pack-id", ver: "1.0.0", enabled: true } },
        failEnqueue: status === "uncertain",
        history: (ui_id, client_id) => {
          historySeen.resolve()
          return status === "closed"
            ? { history: {} }
            : {
                history: { ui_id, client_id, status: { completed: true, status_str: status } },
              }
        },
      })
      await fixture.controller.open()
      const batch = fixture.controller.submitAll("updates")
      if (status === "closed") {
        await historySeen.promise
        expect(fixture.toasts).toEqual([])
        fixture.controller.close()
      }
      await batch
      expect(
        fixture.toasts.filter((toast) => (toast as { severity: string }).severity === "success"),
      ).toEqual([])
      fixture.controller.close()
    }
  })

  it("loads v2 mappings first, falls back to legacy only on 404, and scans the root workflow", async () => {
    const mappingRoutes: string[] = []
    const fixture = createFixture({
      workflowGraph: { nodes: [workflowNode("MappedNode")] },
      mappingResponse: (route) => {
        mappingRoutes.push(route)
        return route.startsWith("/v2/")
          ? new Response("{}", { status: 404 })
          : new Response(JSON.stringify({ "pack-id": [["MappedNode"], {}] }))
      },
    })

    await fixture.controller.open()

    expect(mappingRoutes).toEqual([
      "/v2/customnode/getmappings?mode=local",
      "/customnode/getmappings?mode=local",
    ])
    expect(fixture.controller.getSnapshot()).toMatchObject({
      workflowStatus: "ready",
      workflowAvailabilityKnown: true,
      workflowPacks: [{ id: "pack-id" }],
      workflowMissingPacks: [{ id: "pack-id" }],
    })
    fixture.controller.close()
  })

  it("keeps runtime metadata results when mapping requests fail", async () => {
    const fixture = createFixture({
      workflowGraph: { nodes: [workflowNode("RuntimeNode", "custom_nodes.folder.nodes")] },
      installed: { folder: { cnr_id: "pack-id", ver: "1.0.0", enabled: true } },
      mappingResponse: () => new Response("{}", { status: 503 }),
    })

    await fixture.controller.open()

    expect(fixture.controller.getSnapshot()).toMatchObject({
      workflowStatus: "degraded",
      workflowPacks: [{ id: "pack-id", installed: { enabled: true } }],
      workflowMissingPacks: [],
    })
    expect(fixture.controller.getSnapshot().workflowError).toContain("HTTP 503")
    fixture.controller.close()
  })

  it("does not classify every workflow pack as missing when installed data fails", async () => {
    const fixture = createFixture({
      workflowGraph: { nodes: [workflowNode("MappedNode")] },
      mappings: { "pack-id": [["MappedNode"], {}] },
      installedRead: () => new Response("{}", { status: 503 }),
    })

    await fixture.controller.open()

    expect(fixture.controller.getSnapshot()).toMatchObject({
      workflowStatus: "degraded",
      workflowAvailabilityKnown: false,
      workflowPacks: [{ id: "pack-id" }],
      workflowMissingPacks: [],
    })
    fixture.controller.close()
  })

  it("rejects install submissions for read-only URL mappings", async () => {
    const fixture = createFixture({
      workflowGraph: { nodes: [workflowNode("UnregisteredNode")] },
      mappings: {
        "https://github.com/example/unregistered-pack": [["UnregisteredNode"], {}],
      },
    })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().workflowPacks[0]!

    expect(pack.readOnly).toBe(true)
    expect(await fixture.controller.submit(pack, "install", "1.0.0")).toBe(false)
    expect(fixture.counts().enqueueCount).toBe(0)
    fixture.controller.close()
  })

  it("rescans the workflow and updates missing membership after an installed refresh", async () => {
    const fixture = createFixture({
      workflowGraph: { nodes: [workflowNode("FirstNode")] },
      mappings: {
        "pack-id": [["FirstNode"], {}],
        "second-pack": [["SecondNode"], {}],
      },
    })
    await fixture.controller.open()
    expect(fixture.controller.getSnapshot().workflowPacks.map((pack) => pack.id)).toEqual([
      "pack-id",
    ])

    fixture.setWorkflow({ nodes: [workflowNode("SecondNode")] })
    await fixture.controller.refresh()
    expect(fixture.controller.getSnapshot().workflowMissingPacks.map((pack) => pack.id)).toEqual([
      "second-pack",
    ])

    fixture.setInstalled({ folder: { cnr_id: "second-pack", ver: "1.0.0", enabled: false } })
    await fixture.controller.refresh()
    expect(fixture.controller.getSnapshot()).toMatchObject({
      workflowAvailabilityKnown: true,
      workflowMissingPacks: [],
      workflowPacks: [{ id: "second-pack", installed: { enabled: false } }],
    })
    fixture.controller.close()
  })

  it("discards mapping results from an earlier closed workflow session", async () => {
    const firstMapping = deferred<Response>()
    const fixture = createFixture({
      workflowGraph: { nodes: [workflowNode("FirstNode")] },
      mappingResponse: (_route, read) =>
        read === 1
          ? firstMapping.promise
          : new Response(JSON.stringify({ "second-pack": [["SecondNode"], {}] })),
    })
    const staleOpen = fixture.controller.open()
    fixture.controller.close()
    fixture.setWorkflow({ nodes: [workflowNode("SecondNode")] })
    await fixture.controller.open()
    firstMapping.resolve(new Response(JSON.stringify({ "first-pack": [["FirstNode"], {}] })))
    await staleOpen

    expect(fixture.controller.getSnapshot().workflowPacks.map((pack) => pack.id)).toEqual([
      "second-pack",
    ])
    fixture.controller.close()
  })

  it("clears confirmed missing membership if a task-driven installed refresh fails", async () => {
    const fixture = createFixture({
      workflowGraph: { nodes: [workflowNode("MappedNode")] },
      mappings: { "pack-id": [["MappedNode"], {}] },
      installedRead: (read) =>
        read === 1 ? new Response(JSON.stringify({})) : new Response("{}", { status: 503 }),
      history: (taskId, clientId) => ({
        history: {
          ui_id: taskId,
          client_id: clientId,
          status: { status_str: "success", completed: true },
        },
      }),
    })
    await fixture.controller.open()
    expect(fixture.controller.getSnapshot().workflowMissingPacks).toHaveLength(1)

    await fixture.controller.submit(fixture.controller.getSnapshot().packs[0]!, "install", "1.2.3")

    expect(fixture.controller.getSnapshot()).toMatchObject({
      installedStatus: "error",
      workflowAvailabilityKnown: false,
      workflowMissingPacks: [],
    })
    fixture.controller.close()
  })

  it("waits for terminal task history and verifies an exact install before success", async () => {
    let terminal = false
    const fixture = createFixture({
      history: (taskId, clientId) =>
        terminal
          ? {
              history: {
                ui_id: taskId,
                client_id: clientId,
                status: { status_str: "success", completed: true },
              },
            }
          : { history: {} },
      onEnqueue: (payload) => {
        fixture.setInstalled({
          folder: { cnr_id: "pack-id", ver: payload.params.version, enabled: true },
        })
        terminal = true
      },
    })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!

    expect(await fixture.controller.submit(pack, "install", "1.2.3")).toBe(true)
    expect(
      fixture.requests.find((request) => request.route === "/v2/manager/queue/task")?.body,
    ).toMatchObject({
      client_id: "client-test",
      kind: "install",
      params: { id: "pack-id", version: "1.2.3", selected_version: "1.2.3" },
    })
    expect(fixture.controller.getSnapshot().operations[pack.key]).toMatchObject({
      status: "succeeded",
      restartRequired: true,
    })
    fixture.controller.close()
  })

  it("keeps enable success unknown until a fresh installed read confirms the state", async () => {
    const fixture = createFixture({
      installed: { folder: { cnr_id: "pack-id", ver: "1.0.0", enabled: false } },
      history: (taskId, clientId) => ({
        history: {
          ui_id: taskId,
          client_id: clientId,
          status: { status_str: "success", completed: true },
        },
      }),
    })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!
    await fixture.controller.submit(pack, "enable")
    expect(fixture.controller.getSnapshot().operations[pack.key]).toMatchObject({
      status: "unknown",
      managerStatus: "success",
    })

    fixture.setInstalled({ folder: { cnr_id: "pack-id", ver: "1.0.0", enabled: true } })
    await fixture.controller.refresh()
    expect(fixture.controller.getSnapshot().operations[pack.key]?.status).toBe("succeeded")
    fixture.controller.close()
  })

  it("confirms uninstall against the submitted pack even after it leaves the refreshed list", async () => {
    const fixture = createFixture({
      installed: { folder: { cnr_id: "pack-id", ver: "1.0.0", enabled: true } },
      history: (taskId, clientId) => ({
        history: {
          ui_id: taskId,
          client_id: clientId,
          status: { status_str: "success", completed: true },
        },
      }),
      onEnqueue: () => fixture.setInstalled({}),
    })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!

    await fixture.controller.submit(pack, "uninstall")
    expect(fixture.controller.getSnapshot().operations[pack.key]).toMatchObject({
      status: "succeeded",
      restartRequired: true,
    })
    expect(fixture.confirms[0]).toMatchObject({ message: expect.stringContaining("Pack Name") })
    fixture.controller.close()
  })

  it("retries queue start for an accepted task without enqueueing it again", async () => {
    const fixture = createFixture({ failStarts: 1 })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!

    expect(await fixture.controller.submit(pack, "update")).toBe(false)
    expect(fixture.controller.getSnapshot().operations[pack.key]).toMatchObject({
      status: "unknown",
      accepted: true,
      queueStartFailed: true,
    })
    expect(await fixture.controller.retryQueueStart(pack.key)).toBe(true)
    expect(fixture.counts()).toEqual({ enqueueCount: 1, startCount: 2 })
    expect(fixture.controller.getSnapshot().operations[pack.key]?.status).toBe("pending")
    fixture.controller.close()
  })

  it("reserves a pack while confirming and cancels safely when the dialog closes", async () => {
    const confirmation = deferred<boolean>()
    const fixture = createFixture({ confirm: () => confirmation.promise })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!
    const first = fixture.controller.submit(pack, "uninstall")
    expect(await fixture.controller.submit(pack, "uninstall")).toBe(false)
    expect(fixture.confirms).toHaveLength(1)

    fixture.controller.close()
    confirmation.resolve(true)
    expect(await first).toBe(false)
    expect(fixture.counts().enqueueCount).toBe(0)
  })

  it("ignores version responses from a closed dialog session", async () => {
    const versionResponse = deferred<Response>()
    const fixture = createFixture({ loadVersions: () => versionResponse.promise })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!
    const loading = fixture.controller.loadVersions(pack)
    fixture.controller.close()
    await fixture.controller.open()
    versionResponse.resolve(
      new Response(
        JSON.stringify({ versions: [{ version: "1.2.3" }] satisfies RegistryVersion[] }),
      ),
    )
    await loading

    expect(fixture.controller.getSnapshot().versions[pack.key]).toMatchObject({ loading: false })
    expect(fixture.controller.getSnapshot().versions[pack.key]?.values).toBeUndefined()
    fixture.controller.close()
  })

  it("reconciles accepted tasks again after close and reopen", async () => {
    let finished = false
    const fixture = createFixture({
      history: (taskId, clientId) =>
        finished
          ? {
              history: {
                ui_id: taskId,
                client_id: clientId,
                status: { status_str: "success", completed: true },
              },
            }
          : { history: {} },
      onEnqueue: () =>
        fixture.setInstalled({ folder: { cnr_id: "pack-id", ver: "1.2.3", enabled: true } }),
    })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!
    await fixture.controller.submit(pack, "install", "1.2.3")
    expect(fixture.controller.getSnapshot().operations[pack.key]?.status).toBe("pending")

    fixture.controller.close()
    finished = true
    await fixture.controller.open()
    expect(fixture.controller.getSnapshot().operations[pack.key]).toMatchObject({
      status: "succeeded",
      restartRequired: true,
    })
    fixture.controller.close()
  })

  it("keeps task identity locked when a recovered catalog changes the card key", async () => {
    const fixture = createFixture({
      catalogAvailable: false,
      installed: { folder: { aux_id: "owner/pack", ver: "abc", enabled: true } },
    })
    await fixture.controller.open()
    const installedOnlyPack = fixture.controller.getSnapshot().packs[0]!
    expect(installedOnlyPack.key).toBe("installed:folder")
    await fixture.controller.submit(installedOnlyPack, "disable")

    fixture.setCatalogAvailable(true)
    await fixture.controller.refresh()
    const catalogPack = fixture.controller.getSnapshot().packs[0]!
    expect(catalogPack.key).toBe("registry:pack-id")
    expect(await fixture.controller.submit(catalogPack, "disable")).toBe(false)
    expect(fixture.counts().enqueueCount).toBe(1)
    fixture.controller.close()
  })

  it("keeps lost enqueue responses uncertain and supplies bounded request signals", async () => {
    const fixture = createFixture({ failEnqueue: true })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!

    expect(await fixture.controller.submit(pack, "update")).toBe(false)
    expect(fixture.controller.getSnapshot().operations[pack.key]).toMatchObject({
      status: "unknown",
    })
    expect(fixture.controller.getSnapshot().operations[pack.key]?.accepted).toBeUndefined()
    expect(await fixture.controller.retryQueueStart(pack.key)).toBe(false)
    expect(fixture.signals.length).toBeGreaterThan(0)
    expect(fixture.signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    expect(fixture.counts()).toEqual({ enqueueCount: 1, startCount: 0 })
    fixture.controller.close()
  })

  it("does not let an older installed read overwrite a terminal task refresh", async () => {
    let terminal = false
    const staleInstalledRead = deferred<Response>()
    const fixture = createFixture({
      history: (taskId, clientId) =>
        terminal
          ? {
              history: {
                ui_id: taskId,
                client_id: clientId,
                status: { status_str: "success", completed: true },
              },
            }
          : { history: {} },
      installedRead: (read) => {
        if (read === 2) return staleInstalledRead.promise
        if (read === 3)
          return new Response(
            JSON.stringify({ folder: { cnr_id: "pack-id", ver: "1.2.3", enabled: true } }),
          )
        return new Response(JSON.stringify({}))
      },
    })
    await fixture.controller.open()
    const pack = fixture.controller.getSnapshot().packs[0]!
    await fixture.controller.submit(pack, "install", "1.2.3")
    terminal = true
    const olderRefresh = fixture.controller.refresh()

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 4500
      const check = () => {
        if (fixture.controller.getSnapshot().operations[pack.key]?.status === "succeeded") resolve()
        else if (Date.now() >= deadline)
          reject(new Error("Terminal task was not reconciled in time."))
        else setTimeout(check, 25)
      }
      setTimeout(check, 25)
    })
    staleInstalledRead.resolve(new Response(JSON.stringify({})))
    await olderRefresh

    expect(fixture.controller.getSnapshot().installed).toMatchObject([
      { cnrId: "pack-id", version: "1.2.3" },
    ])
    expect(fixture.controller.getSnapshot().operations[pack.key]?.status).toBe("succeeded")
    fixture.controller.close()
  })
})
