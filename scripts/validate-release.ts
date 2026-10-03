import fs from "node:fs/promises"
import Path from "node:path"

type ReleaseMetadata = {
  packageName: unknown
  projectName: unknown
  repository: unknown
  publisherId: unknown
  displayName: unknown
  icon: unknown
  frontendProjectId: unknown
  frontendProjectName: unknown
  githubRepository?: string
}

type ProjectConfig = {
  project?: {
    name?: unknown
    urls?: { Repository?: unknown }
  }
  tool?: {
    comfy?: {
      PublisherId?: unknown
      DisplayName?: unknown
      Icon?: unknown
    }
  }
}

const TEMPLATE_VALUES = new Set([
  "comfyui-custom-node-template",
  "my custom node",
  "your-name",
  "your-repo",
  "your-username",
])

const projectDir = Path.resolve(import.meta.dir, "../")

function nonEmptyString(value: unknown, field: string, errors: string[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string.`)
    return undefined
  }
  return value.trim()
}

function containsTemplateValue(value: string): boolean {
  const normalized = value.toLowerCase()
  return [...TEMPLATE_VALUES].some((templateValue) => normalized.includes(templateValue))
}

function readConstant(source: string, name: string, language: "typescript" | "python"): string {
  const prefix = language === "typescript" ? `export\\s+const\\s+${name}` : name
  const match = source.match(new RegExp(`^${prefix}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"))
  if (!match) {
    throw new Error(`Could not read ${name} from ${language} source.`)
  }
  return match[1]!
}

export function validateReleaseMetadata(metadata: ReleaseMetadata): string[] {
  const errors: string[] = []
  const projectName = nonEmptyString(metadata.projectName, "pyproject project.name", errors)
  const packageName = nonEmptyString(metadata.packageName, "package.json name", errors)
  const repository = nonEmptyString(metadata.repository, "pyproject Repository", errors)
  const publisherId = nonEmptyString(metadata.publisherId, "tool.comfy.PublisherId", errors)
  const displayName = nonEmptyString(metadata.displayName, "tool.comfy.DisplayName", errors)
  const icon = nonEmptyString(metadata.icon, "tool.comfy.Icon", errors)
  const frontendProjectId = nonEmptyString(
    metadata.frontendProjectId,
    "frontend PROJECT_ID",
    errors,
  )
  const frontendProjectName = nonEmptyString(
    metadata.frontendProjectName,
    "frontend PROJECT_NAME",
    errors,
  )

  for (const [field, value] of [
    ["pyproject project.name", projectName],
    ["package.json name", packageName],
    ["pyproject Repository", repository],
    ["tool.comfy.PublisherId", publisherId],
    ["tool.comfy.DisplayName", displayName],
    ["tool.comfy.Icon", icon],
    ["frontend PROJECT_ID", frontendProjectId],
    ["frontend PROJECT_NAME", frontendProjectName],
  ] as const) {
    if (value && containsTemplateValue(value)) {
      errors.push(`${field} still contains a template value: ${value}`)
    }
  }

  if (projectName && packageName && projectName !== packageName) {
    errors.push(
      `package.json name (${packageName}) must match pyproject project.name (${projectName}).`,
    )
  }
  if (projectName && frontendProjectId && projectName !== frontendProjectId) {
    errors.push(
      `frontend PROJECT_ID (${frontendProjectId}) must match project.name (${projectName}).`,
    )
  }
  if (displayName && frontendProjectName && displayName !== frontendProjectName) {
    errors.push(
      `frontend PROJECT_NAME (${frontendProjectName}) must match DisplayName (${displayName}).`,
    )
  }
  if (repository && metadata.githubRepository) {
    const expectedRepository = `https://github.com/${metadata.githubRepository}`.toLowerCase()
    if (repository.replace(/\/$/, "").toLowerCase() !== expectedRepository) {
      errors.push(`Repository must be ${expectedRepository} for this GitHub repository.`)
    }
  }

  return errors
}

export async function validateRelease(projectRoot = projectDir): Promise<string[]> {
  const [pyprojectSource, packageSource, frontendSource] = await Promise.all([
    fs.readFile(Path.join(projectRoot, "pyproject.toml"), "utf8"),
    fs.readFile(Path.join(projectRoot, "package.json"), "utf8"),
    fs.readFile(Path.join(projectRoot, "frontend", "src", "constants.ts"), "utf8"),
  ])
  const pyproject = Bun.TOML.parse(pyprojectSource) as ProjectConfig
  const packageJson = JSON.parse(packageSource) as { name?: unknown }

  return validateReleaseMetadata({
    packageName: packageJson.name,
    projectName: pyproject.project?.name,
    repository: pyproject.project?.urls?.Repository,
    publisherId: pyproject.tool?.comfy?.PublisherId,
    displayName: pyproject.tool?.comfy?.DisplayName,
    icon: pyproject.tool?.comfy?.Icon,
    frontendProjectId: readConstant(frontendSource, "PROJECT_ID", "typescript"),
    frontendProjectName: readConstant(frontendSource, "PROJECT_NAME", "typescript"),
    githubRepository: process.env.GITHUB_REPOSITORY,
  })
}

if (import.meta.main) {
  const errors = await validateRelease()
  if (errors.length > 0) {
    console.error("Release metadata validation failed:")
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    console.error("Run `bun run init:template` and fix the fields above before tagging a release.")
    process.exit(1)
  }
  console.log("Release metadata is ready for publishing.")
}
