import fs from "node:fs/promises"
import Path from "node:path"

export const projectDir = Path.resolve(import.meta.dir, "../")

function stripJsonComments(source: string): string {
  let result = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    const next = source[index + 1]

    if (inString) {
      result += character
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      result += character
    } else if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1
      result += "\n"
    } else if (character === "/" && next === "*") {
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") result += "\n"
        index += 1
      }
      index += 1
    } else {
      result += character
    }
  }

  return result
}

function stripTrailingCommas(source: string): string {
  let result = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (inString) {
      result += character
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      result += character
      continue
    }

    if (character === ",") {
      let lookahead = index + 1
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1
      if (source[lookahead] === "}" || source[lookahead] === "]") continue
    }
    result += character
  }

  return result
}

export function parseJsonc(source: string): Record<string, unknown> {
  const withoutComments = stripJsonComments(source)
  const withoutTrailingCommas = stripTrailingCommas(withoutComments)
  const value = JSON.parse(withoutTrailingCommas) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected .vscode/settings.json to contain a JSON object.")
  }
  return value as Record<string, unknown>
}

export function getComfyUIPath(args = process.argv.slice(2)): string {
  const optionIndex = args.indexOf("--comfyui-path")
  const optionValue = optionIndex >= 0 ? args[optionIndex + 1] : undefined
  if (optionIndex >= 0 && (!optionValue || optionValue.startsWith("--"))) {
    throw new Error("--comfyui-path requires a path value.")
  }

  const configuredPath = optionValue ?? process.env.COMFYUI_PATH
  if (!configuredPath?.trim()) {
    throw new Error(
      "COMFYUI_PATH is not set. Copy .env.example to .env.local and set your ComfyUI root.",
    )
  }

  if (!Path.isAbsolute(configuredPath)) {
    throw new Error(`COMFYUI_PATH must be absolute: ${configuredPath}`)
  }
  return Path.resolve(configuredPath)
}

export async function validateComfyUIPath(comfyuiPath: string): Promise<void> {
  for (const relativePath of ["comfy_api", "custom_nodes"]) {
    const candidate = Path.join(comfyuiPath, relativePath)
    const stats = await fs.lstat(candidate).catch(() => undefined)
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Expected a regular directory at ${candidate}`)
    }
  }
}

export async function assertSafeDeployTarget(
  customNodesPath: string,
  destinationPath: string,
): Promise<void> {
  const relative = Path.relative(customNodesPath, destinationPath)
  if (
    !relative ||
    relative.startsWith("..") ||
    Path.isAbsolute(relative) ||
    relative.includes(Path.sep)
  ) {
    throw new Error(`Refusing unsafe deploy target: ${destinationPath}`)
  }

  const stats = await fs.lstat(destinationPath).catch(() => undefined)
  if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
    throw new Error(`Deploy target must be a regular directory: ${destinationPath}`)
  }
}
