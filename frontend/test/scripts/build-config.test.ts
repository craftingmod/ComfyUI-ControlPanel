import { describe, expect, it } from "bun:test"
import path from "node:path"

import {
  FRONTEND_ENTRY,
  FRONTEND_ROOT,
  OUTPUT_DIRECTORY,
  REACT_VENDOR_ENTRY,
  buildConfig,
} from "../../build.ts"

describe("Bun build config", () => {
  it("builds the frontend entry into the repository web directory", () => {
    expect(FRONTEND_ROOT).toBe(path.resolve(process.cwd(), "frontend"))
    expect(FRONTEND_ENTRY).toBe(path.resolve(process.cwd(), "frontend/src/index.ts"))
    expect(OUTPUT_DIRECTORY).toBe(path.resolve(process.cwd(), "web"))
    expect(buildConfig.entrypoints).toEqual([FRONTEND_ENTRY, REACT_VENDOR_ENTRY])
    expect(buildConfig.outdir).toBe(OUTPUT_DIRECTORY)
  })

  it("emits a browser ESM bundle with stable ComfyUI entry naming", () => {
    expect(buildConfig.target).toBe("browser")
    expect(buildConfig.format).toBe("esm")
    expect(buildConfig.splitting).toBeTrue()
    expect(buildConfig.naming).toEqual({
      entry: "[name].[ext]",
      chunk: "vendor-react-[hash].mjs",
      asset: "[name].[ext]",
    })
  })

  it("keeps ComfyUI runtime modules external", () => {
    expect(buildConfig.external).toEqual(["*/scripts/app.js", "*/scripts/api.js"])
  })

  it("bundles the ControlPanel entry and CSS Module stylesheet for browsers", async () => {
    const result = await Bun.build({ ...buildConfig, outdir: undefined })
    expect(result.success).toBeTrue()
    expect(result.logs).toHaveLength(0)
    const app = result.outputs.find((output) => path.basename(output.path) === "index.js")!
    const appSource = await app.text()
    expect(appSource).toMatch(/from\s*["']\.\/vendor-react-[^"']+\.mjs["']/)
    expect(appSource.includes('Symbol.for("react.transitional.element")')).toBeFalse()
    expect(appSource.includes('rendererPackageName:"react-dom"')).toBeFalse()
    const vendor = result.outputs.find((output) =>
      /^vendor-react-.+\.mjs$/.test(path.basename(output.path)),
    )!
    const vendorSource = await vendor.text()
    expect(vendorSource.includes('Symbol.for("react.transitional.element")')).toBeTrue()
    expect(vendorSource.includes('rendererPackageName:"react-dom"')).toBeTrue()
    expect(vendorSource).not.toContain("control-panel.open")
    const facade = result.outputs.find(
      (output) => path.basename(output.path) === "vendor-react.js",
    )!
    expect(await facade.text()).not.toContain("registerExtension")
    expect(facade.size).toBeLessThan(1024)
    expect(result.outputs.some((output) => path.basename(output.path) === "index.css")).toBeTrue()
    const bundle = (await Promise.all(result.outputs.map((output) => output.text()))).join("\n")
    expect(bundle).not.toContain("process.env.NODE_ENV")
    expect(bundle).toMatch(/from\s*["']\.\.\/\.\.\/scripts\/app\.js["']/)
    expect(bundle).toContain("control-panel.open")
    expect(bundle).toContain("1180px")
    expect(bundle).toContain("data-template-theme")
    expect(bundle).not.toContain("Count: 0")
  })
})
