import Path from "node:path"

import { $ } from "bun"

import { getProjectVersion } from "./project-version.ts"

const projectDir = Path.resolve(import.meta.dir, "../")

$.cwd(projectDir)

const statusBeforeBump = (await $`git status --porcelain --untracked-files=normal`.text()).trim()
const wasClean = statusBeforeBump.length === 0
const currentVersion = await getProjectVersion(projectDir)
const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(currentVersion)

if (!versionMatch) {
  throw new Error(`Expected a stable semantic Git-tag version, got ${currentVersion}.`)
}

const newVersion = `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 1}`
const tagName = `v${newVersion}`
const existingTag = (await $`git tag --list ${tagName}`.text()).trim()
if (existingTag) {
  throw new Error(`Tag ${tagName} already exists; refusing to bump the version`)
}

if (wasClean) {
  await $`git tag ${tagName}`
  console.log(`Created tag ${tagName} at the current commit.`)
  console.log(`Push tag using commands:\ngit push origin ${tagName}`)
} else {
  console.log("Skipped creating a tag because the working tree is dirty.")
  console.log(
    `Commit the intended changes, then run:\ngit tag ${tagName}\ngit push origin ${tagName}`,
  )
}
