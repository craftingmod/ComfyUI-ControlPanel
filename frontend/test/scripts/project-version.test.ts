import { expect, it } from "bun:test"

import { githubReleaseInfo } from "@scripts/prepare-github-release.ts"
import { projectArchiveName, registryVersionSource } from "@scripts/project-version.ts"

const pyprojectSource = '[project]\nname = "example"\n[tool.comfy]\nDisplayName = "Example Node"'

it("generates the version assignment read by comfy-cli", () => {
  for (const version of [
    "1.2.3",
    "1.2.3+react",
    "1.2.3rc1",
    "1.2.3.dev1",
    "0.9.4.post7.dev0+d064875",
    "1.2.3-rc.1+build.2",
  ]) {
    expect(registryVersionSource(version)).toBe(`__version__ = "${version}"\n`)
    expect(projectArchiveName("Example Node", version)).toBe(`Example Node-${version}.zip`)
    expect(githubReleaseInfo(pyprojectSource, `v${version}`)).toEqual({
      archivePath: `build/Example Node-${version}.zip`,
      projectName: "example",
      version,
    })
  }
  for (const version of ["1.2", "1.2.3.", "1.2.3/extra", '1.2.3"\ninvalid']) {
    expect(() => registryVersionSource(version)).toThrow("X.Y.Z")
    expect(() => githubReleaseInfo(pyprojectSource, `v${version}`)).toThrow("vX.Y.Z")
  }
})

it("uses the resolved project version for release archive names", () => {
  expect(githubReleaseInfo(pyprojectSource, "v1.2.0-react", "1.2.0+react")).toEqual({
    archivePath: "build/Example Node-1.2.0+react.zip",
    projectName: "example",
    version: "1.2.0+react",
  })
})

it("rejects missing or unsafe archive display names", () => {
  for (const name of [
    undefined,
    "",
    "../example",
    "example\\node",
    "example:node",
    "example\nnode",
  ]) {
    expect(() => projectArchiveName(name, "1.2.3")).toThrow("tool.comfy.DisplayName")
  }
})
