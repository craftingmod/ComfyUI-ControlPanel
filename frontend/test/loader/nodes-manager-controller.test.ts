import { describe, expect, it } from "bun:test"

import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"

import type { ManagerQueuePayload, RegistryVersion } from "../../src/services/nodesManager.ts"
import { createNodesManagerController } from "../../src/services/nodesManagerController.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type FixtureOptions = {
  confirm?: (options: { title: string; message: string }) => Promise<boolean>
  failEnqueue?: boolean
  failStarts?: number
  history?: (taskId: string, clientId: string) => unknown
  installed?: Record<string, unknown>
  installedRead?: (read: number) => Promise<Response> | Response
  onEnqueue?: (payload: ManagerQueuePayload) => void
  catalogAvailable?: boolean
  loadVersions?: () => Promise<Response>
}

function createFixture(options: FixtureOptions = {}) {
  let installed = options.installed ?? {}
  let startFailures = options.failStarts ?? 0
  let catalogAvailable = options.catalogAvailable ?? true
  let installedReads = 0
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
              nodes: [
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
    counts: () => ({ enqueueCount, startCount }),
  }
}

describe("Nodes Manager controller", () => {
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
