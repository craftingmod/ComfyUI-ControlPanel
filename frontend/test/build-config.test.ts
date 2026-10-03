import path from "node:path"

import { describe, expect, it } from "vitest"

import { buildConfig, FRONTEND_ENTRY, OUTPUT_DIRECTORY } from "../build.ts"

describe("Bun build config", () => {
  it("bundles the existing entry into the ComfyUI web directory", () => {
    expect(FRONTEND_ENTRY).toBe(path.resolve("frontend/src/index.ts"))
    expect(OUTPUT_DIRECTORY).toBe(path.resolve("dist"))
    expect(buildConfig.entrypoints).toEqual([FRONTEND_ENTRY])
    expect(buildConfig.naming.entry).toBe("[name].[ext]")
    expect(buildConfig.target).toBe("browser")
    expect(buildConfig.format).toBe("esm")
  })

  it("imports ComfyUI at runtime and keeps production output", () => {
    expect(buildConfig.banner).toBe('import { app } from "/scripts/app.js";')
    expect(buildConfig.external).toContain("*/scripts/app.js")
    expect(buildConfig.define["process.env.NODE_ENV"]).toBe('"production"')
  })
})
