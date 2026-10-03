import fs from "node:fs/promises"
import Path from "node:path"

import { $ } from "bun"
import { unzipSync } from "fflate"

import {
  assertSafeDeployTarget,
  getComfyUIPath,
  projectDir,
  validateComfyUIPath,
} from "./local-comfyui.ts"
import { getProjectVersion, projectArchiveName } from "./project-version.ts"

type ProjectConfig = {
  project?: { name?: unknown }
  tool?: { comfy?: { DisplayName?: unknown } }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected ${field} to be a non-empty string in pyproject.toml`)
  }
  return value.trim()
}

async function main(): Promise<void> {
  const comfyuiPath = getComfyUIPath()
  await validateComfyUIPath(comfyuiPath)

  const pyproject = Bun.TOML.parse(
    await fs.readFile(Path.join(projectDir, "pyproject.toml"), "utf8"),
  ) as ProjectConfig
  const projectName = requireString(pyproject.project?.name, "project.name")
  const version = await getProjectVersion(projectDir)
  const archiveName = projectArchiveName(pyproject.tool?.comfy?.DisplayName, version)
  const customNodesPath = Path.join(comfyuiPath, "custom_nodes")
  const destinationPath = Path.join(customNodesPath, projectName)
  await assertSafeDeployTarget(customNodesPath, destinationPath)

  $.cwd(projectDir)
  await $`bun run build:custom-node`

  const archivePath = Path.join(projectDir, "build", archiveName)
  const archive = unzipSync(new Uint8Array(await fs.readFile(archivePath)))
  const stagingPath = Path.join(customNodesPath, `.${projectName}.deploy-${process.pid}`)
  const backupPath = Path.join(customNodesPath, `.${projectName}.backup-${process.pid}`)

  await fs.mkdir(stagingPath)
  try {
    for (const [relativePath, contents] of Object.entries(archive)) {
      const outputPath = Path.resolve(stagingPath, relativePath)
      const relative = Path.relative(stagingPath, outputPath)
      if (relative.startsWith("..") || Path.isAbsolute(relative)) {
        throw new Error(`Refusing unsafe archive entry: ${relativePath}`)
      }
      await fs.mkdir(Path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, contents)
    }

    const destinationExists = await fs.stat(destinationPath).then(
      () => true,
      () => false,
    )
    if (destinationExists) await fs.rename(destinationPath, backupPath)
    try {
      await fs.rename(stagingPath, destinationPath)
    } catch (error) {
      if (destinationExists) await fs.rename(backupPath, destinationPath)
      throw error
    }
    if (destinationExists) await fs.rm(backupPath, { recursive: true })
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true }).catch(() => undefined)
    throw error
  }

  console.log(`Deployed ${projectName} ${version} to ${destinationPath}.`)
}

if (import.meta.main) {
  await main()
}
