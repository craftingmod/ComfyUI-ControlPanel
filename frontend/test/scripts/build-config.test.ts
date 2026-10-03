import { describe, expect, it } from "bun:test"
import path from "node:path"

import { FRONTEND_ENTRY, FRONTEND_ROOT, OUTPUT_DIRECTORY, buildConfig } from "../../build.ts"

describe("Bun build config", () => {
  it("builds the frontend entry into the repository dist directory", () => {
    expect(FRONTEND_ROOT).toBe(path.resolve(process.cwd(), "frontend"))
    expect(FRONTEND_ENTRY).toBe(path.resolve(process.cwd(), "frontend/src/index.ts"))
    expect(OUTPUT_DIRECTORY).toBe(path.resolve(process.cwd(), "dist"))
    expect(buildConfig.entrypoints).toEqual([FRONTEND_ENTRY])
    expect(buildConfig.outdir).toBe(OUTPUT_DIRECTORY)
  })

  it("emits a browser ESM bundle with stable ComfyUI entry naming", () => {
    expect(buildConfig.target).toBe("browser")
    expect(buildConfig.format).toBe("esm")
    expect(buildConfig.naming).toEqual({
      entry: "[name].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name].[ext]",
    })
  })

  it("keeps ComfyUI runtime modules external", () => {
    expect(buildConfig.external).toEqual(["*/scripts/app.js", "*/scripts/api.js"])
  })

  it("bundles the ControlPanel entry and native styles for browsers", async () => {
    const result = await Bun.build({ ...buildConfig, outdir: undefined })
    expect(result.success).toBeTrue()
    expect(result.logs).toHaveLength(0)
    const bundle = await result.outputs[0]!.text()
    expect(bundle).not.toContain("process.env.NODE_ENV")
    expect(bundle).toMatch(/from\s*["']\.\.\/\.\.\/scripts\/app\.js["']/)
    expect(bundle).toContain("control-panel.open")
    expect(bundle).toContain("cp-backdrop")
    expect(bundle).not.toContain("Count:")
  })
})
