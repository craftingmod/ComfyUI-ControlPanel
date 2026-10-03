import fs from "node:fs/promises"
import Path from "node:path"
import { createInterface } from "node:readline/promises"

import { projectArchiveName } from "./project-version.ts"

const projectDir = Path.resolve(import.meta.dir, "../")

function requireMatch(value: string, pattern: RegExp, message: string): string {
  const trimmed = value.trim()

  if (!pattern.test(trimmed)) {
    throw new Error(message)
  }

  return trimmed
}

export function validateProjectId(value: string): string {
  const projectId = requireMatch(
    value,
    /^[a-z](?:[a-z0-9]|[._-](?=[a-z0-9]))*$/,
    "Project ID must start with a lowercase letter and use lowercase letters, numbers, '.', '_' or single '-'.",
  )

  if (projectId.length >= 100) {
    throw new Error("Project ID must be less than 100 characters long.")
  }

  return projectId
}

export function validateProjectName(value: string): string {
  const projectName = value.trim()
  const hasControlCharacter = projectName.split("").some((character) => {
    const codePoint = character.charCodeAt(0)
    return codePoint < 32 || codePoint === 127
  })
  if (projectName.length === 0 || projectName.length > 100 || hasControlCharacter) {
    throw new Error(
      "Project Name must be a non-empty display name without control characters and at most 100 characters long.",
    )
  }

  projectArchiveName(projectName, "0.0.0")
  return projectName
}

export function validateGitHubUsername(value: string): string {
  const username = requireMatch(
    value,
    /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
    "GitHub username must contain only letters, numbers or single hyphens, and cannot start or end with a hyphen.",
  )

  if (username.length > 39) {
    throw new Error("GitHub username must be at most 39 characters long.")
  }

  return username
}

export function validateGitHubRepo(value: string): string {
  const repo = requireMatch(
    value,
    /^[A-Za-z0-9._-]+$/,
    "GitHub repository name must contain only letters, numbers, '.', '_' or '-'.",
  )

  if (repo.length > 100 || repo === "." || repo === "..") {
    throw new Error("GitHub repository name must be valid and at most 100 characters long.")
  }

  return repo
}

export function validatePublisherId(value: string): string {
  const publisherId = requireMatch(
    value,
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    "Registry Publisher ID must use lowercase letters, numbers, '.', '_' or '-'.",
  )

  if (publisherId.length > 100) {
    throw new Error("Registry Publisher ID must be at most 100 characters long.")
  }

  return publisherId
}

function replaceQuotedValue(source: string, pattern: RegExp, value: string, label: string): string {
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${label}`)
  }

  return source.replace(pattern, (_match, prefix: string) => `${prefix}${JSON.stringify(value)}`)
}

export async function initializeTemplate(
  projectId: string,
  projectName: string,
  githubUsername: string,
  githubRepo: string,
  publisherId: string,
  projectRoot = projectDir,
): Promise<void> {
  projectId = validateProjectId(projectId)
  projectName = validateProjectName(projectName)
  githubUsername = validateGitHubUsername(githubUsername)
  githubRepo = validateGitHubRepo(githubRepo)
  publisherId = validatePublisherId(publisherId)

  const pyprojectPath = Path.join(projectRoot, "pyproject.toml")
  const packagePath = Path.join(projectRoot, "package.json")
  const constantsPath = Path.join(projectRoot, "frontend", "src", "constants.ts")
  const nodePath = Path.join(projectRoot, "backend", "nodes", "example_normalize_text.py")
  const readmePath = Path.join(projectRoot, "README.md")
  const [originalPyproject, originalPackage, originalConstants, originalNode, originalReadme] =
    await Promise.all([
      fs.readFile(pyprojectPath, "utf8"),
      fs.readFile(packagePath, "utf8"),
      fs.readFile(constantsPath, "utf8"),
      fs.readFile(nodePath, "utf8"),
      fs.readFile(readmePath, "utf8"),
    ])

  const projectSectionPattern = /(^\[project\]\s*$)([\s\S]*?)(?=^\[|(?![\s\S]))/m
  const projectSection = originalPyproject.match(projectSectionPattern)
  if (!projectSection) {
    throw new Error("Could not find [project] in pyproject.toml")
  }

  const updatedProjectSection = replaceQuotedValue(
    projectSection[0],
    /^(name\s*=\s*)["'][^"']+["']\s*$/m,
    projectId,
    "project.name in pyproject.toml",
  )

  let updatedPyproject = originalPyproject.replace(
    projectSectionPattern,
    () => updatedProjectSection,
  )
  updatedPyproject = replaceQuotedValue(
    updatedPyproject,
    /^(Repository\s*=\s*)["'][^"']+["']\s*$/m,
    `https://github.com/${githubUsername}/${githubRepo}`,
    "project.urls.Repository in pyproject.toml",
  )
  updatedPyproject = replaceQuotedValue(
    updatedPyproject,
    /^(PublisherId\s*=\s*)["'][^"']+["']\s*$/m,
    publisherId,
    "tool.comfy.PublisherId in pyproject.toml",
  )
  updatedPyproject = replaceQuotedValue(
    updatedPyproject,
    /^(DisplayName\s*=\s*)["'][^"']+["']\s*$/m,
    projectName,
    "tool.comfy.DisplayName in pyproject.toml",
  )
  updatedPyproject = replaceQuotedValue(
    updatedPyproject,
    /^(Icon\s*=\s*)["'][^"']+["']\s*$/m,
    `https://cdn.jsdelivr.net/gh/${githubUsername}/${githubRepo}/assets/icon.svg`,
    "tool.comfy.Icon in pyproject.toml",
  )

  const packageJson = JSON.parse(originalPackage) as Record<string, unknown>
  packageJson.name = projectId
  const updatedPackage = `${JSON.stringify(packageJson, null, 2)}\n`
  let updatedConstants = replaceQuotedValue(
    originalConstants,
    /^(export const PROJECT_ID\s*=\s*)["'][^"']+["']\s*$/m,
    projectId,
    "PROJECT_ID in frontend/src/constants.ts",
  )
  updatedConstants = replaceQuotedValue(
    updatedConstants,
    /^(export const PROJECT_NAME\s*=\s*)["'][^"']+["']\s*$/m,
    projectName,
    "PROJECT_NAME in frontend/src/constants.ts",
  )
  let updatedNode = replaceQuotedValue(
    originalNode,
    /^(PROJECT_ID\s*=\s*)["'][^"']+["']\s*$/m,
    projectId,
    "PROJECT_ID in the example backend node",
  )
  updatedNode = replaceQuotedValue(
    updatedNode,
    /^(PROJECT_NAME\s*=\s*)["'][^"']+["']\s*$/m,
    projectName,
    "PROJECT_NAME in the example backend node",
  )

  if (!/^# .+$/m.test(originalReadme)) {
    throw new Error("Could not find the project title in README.md")
  }
  const updatedReadme = originalReadme.replace(/^# .+$/m, () => `# ${projectName}`)

  await Promise.all([
    fs.writeFile(pyprojectPath, updatedPyproject),
    fs.writeFile(packagePath, updatedPackage),
    fs.writeFile(constantsPath, updatedConstants),
    fs.writeFile(nodePath, updatedNode),
    fs.writeFile(readmePath, updatedReadme),
  ])
}

async function main(): Promise<void> {
  let answers: [string, string, string, string, string]

  if (process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stdout })

    try {
      answers = [
        await input.question("Project ID: "),
        await input.question("Project Name: "),
        await input.question("GitHub username: "),
        await input.question("GitHub repository name: "),
        await input.question("Comfy Registry Publisher ID: "),
      ]
    } finally {
      input.close()
    }
  } else {
    const lines = (await Bun.stdin.text()).split(/\r?\n/)
    if (lines.length < 5) {
      throw new Error(
        "Expected five stdin lines: Project ID, Project Name, GitHub username, GitHub repository name and Comfy Registry Publisher ID.",
      )
    }
    answers = [lines[0]!, lines[1]!, lines[2]!, lines[3]!, lines[4]!]
  }

  const projectId = answers[0].trim()
  const projectName = answers[1].trim()
  const githubUsername = answers[2].trim()
  const githubRepo = answers[3].trim()
  const publisherId = answers[4].trim()

  await initializeTemplate(projectId, projectName, githubUsername, githubRepo, publisherId)
  console.log(
    `Initialized ${projectName} (${projectId}) for https://github.com/${githubUsername}/${githubRepo}.`,
  )
  console.log(
    "Versions come from Git tags. In a new repository, create an initial tag (for example, `git tag v0.1.0`) before running `uv lock`.",
  )
  console.log("Run `uv lock` and `bun install` to refresh the lockfiles.")
  console.log("Update the project description, LICENSE copyright holder, and assets/icon.svg.")
}

if (import.meta.main) {
  await main()
}
