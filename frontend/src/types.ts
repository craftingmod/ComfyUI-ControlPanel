import type { ComfyApp, Settings } from "@comfyorg/comfyui-frontend-types"

export type JsonObject = Record<string, unknown>
export type ManagerExtension = Parameters<ComfyApp["registerExtension"]>[0]
export type ComfySettingId = keyof Settings
export type ToastSeverity = "success" | "info" | "warn" | "error"

export type UpdateJob = {
  id: string
  label: string
  status: "queued" | "running" | "succeeded" | "failed"
  logs: string[]
  error?: string | null
  restart_required?: boolean
  result?: JsonObject | null
}
