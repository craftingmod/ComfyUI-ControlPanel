import { createHash, randomUUID } from "node:crypto"
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptRoot, "..")
const agentsRoot = path.join(repoRoot, ".agents")
const skillsRoot = path.join(agentsRoot, "skills")
const upstreamRepository = "https://github.com/jtydhr88/comfyui-custom-node-skills.git"
const upstreamSkillsPath = path.join("plugins", "comfyui-custom-nodes", "skills")

async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function collectFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to fingerprint a symbolic link: ${entryPath}`)
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, entryPath)))
    } else if (entry.isFile()) {
      files.push(path.relative(root, entryPath).replaceAll(path.sep, "/"))
    }
  }

  return files
}

async function directoryFingerprint(directoryPath: string): Promise<string> {
  if (!(await isDirectory(directoryPath))) {
    return "<missing>"
  }

  const resolvedRoot = await realpath(directoryPath)
  const files = (await collectFiles(resolvedRoot)).sort((left, right) =>
    left.localeCompare(right, "en"),
  )
  const entries: string[] = []

  for (const relativePath of files) {
    const contents = await readFile(path.join(resolvedRoot, relativePath))
    const hash = createHash("sha256").update(contents).digest("hex").toUpperCase()
    entries.push(`${relativePath}\t${hash}`)
  }

  return entries.join("\n")
}

async function removeValidatedStagingDirectory(stagingRoot: string): Promise<void> {
  if (!(await isDirectory(stagingRoot))) {
    return
  }

  const resolvedStaging = await realpath(stagingRoot)
  const resolvedAgents = await realpath(agentsRoot)
  const stagingStat = await lstat(resolvedStaging)
  const isExpectedStagingDirectory =
    stagingStat.isDirectory() &&
    !stagingStat.isSymbolicLink() &&
    path.dirname(resolvedStaging) === resolvedAgents &&
    /^\.skill-sync-[0-9a-f]{32}$/i.test(path.basename(resolvedStaging))

  if (!isExpectedStagingDirectory) {
    console.warn(
      `Temporary directory was not removed because validation failed: ${resolvedStaging}`,
    )
    return
  }

  await rm(resolvedStaging, { recursive: true, force: true })
}

async function removeValidatedCloneDirectory(cloneRoot: string): Promise<void> {
  const stats = await lstat(cloneRoot).catch(() => undefined)
  if (!stats) return

  const resolvedClone = await realpath(cloneRoot)
  const resolvedTemp = await realpath(os.tmpdir())
  const isExpectedCloneDirectory =
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    path.dirname(resolvedClone) === resolvedTemp &&
    path.basename(resolvedClone).startsWith("comfyui-skill-sync-")

  if (!isExpectedCloneDirectory) {
    console.warn(`Temporary clone was not removed because validation failed: ${resolvedClone}`)
    return
  }

  await rm(resolvedClone, { recursive: true, force: true })
}

async function cloneUpstreamSkills(): Promise<{ cloneRoot: string; sourceRoot: string }> {
  const cloneRoot = await mkdtemp(path.join(os.tmpdir(), "comfyui-skill-sync-"))
  const clone = Bun.spawn(
    ["git", "clone", "--depth", "1", "--single-branch", "--no-tags", upstreamRepository, cloneRoot],
    { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
  )
  const exitCode = await clone.exited
  if (exitCode !== 0) {
    await removeValidatedCloneDirectory(cloneRoot)
    throw new Error(`Failed to clone the default branch of ${upstreamRepository}`)
  }

  return { cloneRoot, sourceRoot: path.join(cloneRoot, upstreamSkillsPath) }
}

async function synchronizeFromSource(requestedSource: string, check: boolean): Promise<number> {
  if (!(await isDirectory(requestedSource))) {
    throw new Error(`Skill source not found: ${requestedSource}`)
  }

  const sourceRoot = await realpath(requestedSource)
  const sourceEntries = await readdir(sourceRoot, { withFileTypes: true })
  const sourceSkills = sourceEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("comfyui-node-"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"))

  if (sourceSkills.length === 0) {
    throw new Error(`No comfyui-node-* skill directories found in: ${sourceRoot}`)
  }

  for (const skill of sourceSkills) {
    const skillPath = path.join(sourceRoot, skill.name)
    if (!(await isFile(path.join(skillPath, "SKILL.md")))) {
      throw new Error(
        `Refusing to sync invalid skill directory (SKILL.md is missing): ${skillPath}`,
      )
    }
  }

  const outdatedSkills: string[] = []
  for (const skill of sourceSkills) {
    const sourceSkill = path.join(sourceRoot, skill.name)
    const destination = path.join(skillsRoot, skill.name)
    if ((await directoryFingerprint(sourceSkill)) !== (await directoryFingerprint(destination))) {
      outdatedSkills.push(skill.name)
    }
  }

  if (outdatedSkills.length === 0) {
    console.log("ComfyUI node skills are up to date.")
    return 0
  }

  if (check) {
    console.log("ComfyUI node skills need synchronization:")
    for (const skillName of outdatedSkills) {
      console.log(`  - ${skillName}`)
    }
    return 1
  }

  await mkdir(skillsRoot, { recursive: true })
  const stagingRoot = path.join(agentsRoot, `.skill-sync-${randomUUID().replaceAll("-", "")}`)
  await mkdir(stagingRoot)

  try {
    for (const skillName of outdatedSkills) {
      const sourceSkill = path.join(sourceRoot, skillName)
      const stagedSkill = path.join(stagingRoot, skillName)
      await cp(sourceSkill, stagedSkill, { recursive: true, errorOnExist: true })

      if ((await directoryFingerprint(sourceSkill)) !== (await directoryFingerprint(stagedSkill))) {
        throw new Error(`Staged copy verification failed for: ${skillName}`)
      }
    }

    for (const skillName of outdatedSkills) {
      const destination = path.join(skillsRoot, skillName)
      const stagedSkill = path.join(stagingRoot, skillName)
      const backup = path.join(stagingRoot, `${skillName}.backup`)
      let hasBackup = false

      if (await isDirectory(destination)) {
        const destinationStat = await lstat(destination)
        if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
          throw new Error(`Refusing to replace a non-directory or symbolic link: ${destination}`)
        }
        await rename(destination, backup)
        hasBackup = true
      } else {
        try {
          await lstat(destination)
          throw new Error(`Refusing to replace a non-directory or symbolic link: ${destination}`)
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error
          }
        }
      }

      try {
        await rename(stagedSkill, destination)
      } catch (error) {
        if (hasBackup) {
          await rename(backup, destination)
        }
        throw error
      }

      if (hasBackup) {
        await rm(backup, { recursive: true, force: true })
      }
      console.log(`Synchronized ${skillName}`)
    }
  } finally {
    await removeValidatedStagingDirectory(stagingRoot)
  }

  console.log(`Synchronized ${outdatedSkills.length} ComfyUI node skill(s).`)
  return 0
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      check: { type: "boolean", default: false },
      source: { type: "string" },
    },
    strict: true,
  })

  const localSource = values.source?.trim()
  if (localSource) return synchronizeFromSource(localSource, values.check)

  const { cloneRoot, sourceRoot } = await cloneUpstreamSkills()
  try {
    return await synchronizeFromSource(sourceRoot, values.check)
  } finally {
    await removeValidatedCloneDirectory(cloneRoot)
  }
}

try {
  globalThis.process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  globalThis.process.exitCode = 1
}
