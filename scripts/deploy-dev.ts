import fs from "node:fs/promises"
import Path from "node:path"

import { getComfyUIPath, projectDir, validateComfyUIPath } from "./local-comfyui.ts"

type ProjectConfig = { project?: { name?: unknown } }

function requireProjectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Expected project.name to be a non-empty string in pyproject.toml")
  }
  return value.trim()
}

async function main(): Promise<void> {
  const comfyuiPath = getComfyUIPath()
  await validateComfyUIPath(comfyuiPath)

  const pyproject = Bun.TOML.parse(
    await fs.readFile(Path.join(projectDir, "pyproject.toml"), "utf8"),
  ) as ProjectConfig
  const projectName = requireProjectName(pyproject.project?.name)
  const customNodesPath = Path.join(comfyuiPath, "custom_nodes")
  const destinationPath = Path.join(customNodesPath, projectName)
  const relative = Path.relative(customNodesPath, destinationPath)
  if (
    !relative ||
    relative.startsWith("..") ||
    Path.isAbsolute(relative) ||
    relative.includes(Path.sep)
  ) {
    throw new Error(`Refusing unsafe development link path: ${destinationPath}`)
  }

  const destinationStats = await fs.lstat(destinationPath).catch(() => undefined)
  if (destinationStats) {
    if (!destinationStats.isSymbolicLink()) {
      throw new Error(
        `Refusing to replace existing non-link path: ${destinationPath}. Move it manually or use deploy:local intentionally.`,
      )
    }

    const [existingTarget, expectedTarget] = await Promise.all([
      fs.realpath(destinationPath),
      fs.realpath(projectDir),
    ])
    if (Path.normalize(existingTarget) !== Path.normalize(expectedTarget)) {
      throw new Error(`Development link already points elsewhere: ${destinationPath}`)
    }

    console.log(`Development link is already configured: ${destinationPath} -> ${projectDir}`)
    return
  }

  await fs.symlink(projectDir, destinationPath, process.platform === "win32" ? "junction" : "dir")
  console.log(`Linked ${destinationPath} -> ${projectDir}`)
}

if (import.meta.main) {
  await main()
}
