import type { ComfyApp } from "@comfyorg/comfyui-frontend-types"
import type { JsonObject, UpdateJob } from "../types.ts"

export type ControlPanelApi = {
  fetchJson: (route: string, body?: JsonObject) => Promise<JsonObject>
}

export function createControlPanelApi(app: ComfyApp): ControlPanelApi {
  return {
    async fetchJson(route: string, body?: JsonObject): Promise<JsonObject> {
      const response = await app.api.fetchApi(route, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = (await response.json()) as JsonObject
      if (!response.ok || data.ok === false) {
        throw new Error(String(data.error ?? response.statusText))
      }
      return data
    },
  }
}

export function isUpdateJob(value: unknown): value is UpdateJob {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as UpdateJob).id === "string"
    && typeof (value as UpdateJob).label === "string"
    && typeof (value as UpdateJob).status === "string",
  )
}
