import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const FRONTEND_ROOT = path.dirname(fileURLToPath(import.meta.url))
export const FRONTEND_ENTRY = path.join(FRONTEND_ROOT, "src", "index.ts")
export const OUTPUT_DIRECTORY = path.resolve(FRONTEND_ROOT, "..", "dist")

export const buildConfig = {
  entrypoints: [FRONTEND_ENTRY],
  outdir: OUTPUT_DIRECTORY,
  target: "browser",
  format: "esm",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  external: ["*/scripts/app.js", "*/scripts/api.js"],
  naming: {
    entry: "[name].[ext]",
    chunk: "[name]-[hash].[ext]",
    asset: "[name].[ext]",
  },
} satisfies Bun.BuildConfig

export async function buildFrontend(): Promise<Bun.BuildOutput> {
  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true })

  const result = await Bun.build(buildConfig)
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log)
    }
    throw new Error("Frontend build failed")
  }

  return result
}

if (import.meta.main) {
  await buildFrontend()
}
