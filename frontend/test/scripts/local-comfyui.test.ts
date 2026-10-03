import { afterEach, describe, expect, test } from "bun:test"
import Path from "node:path"

import { getComfyUIPath, parseJsonc } from "@scripts/local-comfyui.ts"

const originalComfyUIPath = process.env.COMFYUI_PATH

afterEach(() => {
  if (originalComfyUIPath === undefined) {
    delete process.env.COMFYUI_PATH
  } else {
    process.env.COMFYUI_PATH = originalComfyUIPath
  }
})

describe("local ComfyUI configuration", () => {
  test("parses VS Code JSONC while preserving unrelated settings", () => {
    expect(
      parseJsonc(`{
        // Keep this setting.
        "editor.formatOnSave": true,
        "files.exclude": {
          "**/.cache": true,
        },
      }`),
    ).toEqual({
      "editor.formatOnSave": true,
      "files.exclude": { "**/.cache": true },
    })
  })

  test("prefers the command-line path over the environment", () => {
    process.env.COMFYUI_PATH = Path.resolve("env-comfyui")
    const cliPath = Path.resolve("cli-comfyui")
    expect(getComfyUIPath(["--comfyui-path", cliPath])).toBe(cliPath)
  })

  test("requires an absolute configured path", () => {
    process.env.COMFYUI_PATH = "relative/ComfyUI"
    expect(() => getComfyUIPath([])).toThrow("COMFYUI_PATH must be absolute")
  })
})
