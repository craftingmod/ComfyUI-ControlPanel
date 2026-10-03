import fs from "node:fs/promises"
import Path from "node:path"

import { getComfyUIPath, parseJsonc, projectDir, validateComfyUIPath } from "./local-comfyui.ts"

export async function updateVSCodeSettings(comfyuiPath: string): Promise<string> {
  const vscodeDir = Path.join(projectDir, ".vscode")
  const settingsPath = Path.join(vscodeDir, "settings.json")
  const original = await fs.readFile(settingsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}"
    throw error
  })
  const settings = parseJsonc(original)
  settings["python.analysis.extraPaths"] = [comfyuiPath.replaceAll("\\", "/")]

  await fs.mkdir(vscodeDir, { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  return settingsPath
}

async function main(): Promise<void> {
  const comfyuiPath = getComfyUIPath()
  await validateComfyUIPath(comfyuiPath)
  const settingsPath = await updateVSCodeSettings(comfyuiPath)
  console.log(`Configured ${Path.relative(projectDir, settingsPath)} for ${comfyuiPath}.`)
}

if (import.meta.main) {
  await main()
}
