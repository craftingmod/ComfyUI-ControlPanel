import { describe, expect, it } from "bun:test"

import { githubReleaseInfo } from "@scripts/prepare-github-release.ts"

const pyproject = `
[project]
name = "image-tools"
dynamic = ["version"]
[tool.comfy]
DisplayName = "Image Tools"
`

describe("GitHub Release preparation", () => {
  it("derives the current Registry ZIP path from project metadata", () => {
    expect(githubReleaseInfo(pyproject, "v1.2.3")).toEqual({
      archivePath: "build/Image Tools-1.2.3.zip",
      projectName: "image-tools",
      version: "1.2.3",
    })
  })

  it("uses the release tag as the version", () => {
    expect(githubReleaseInfo(pyproject, "v1.2.4").version).toBe("1.2.4")
  })

  it("rejects a malformed release tag", () => {
    expect(() => githubReleaseInfo(pyproject, "1.2.3")).toThrow("Expected release tag vX.Y.Z")
  })

  it("requires the project name", () => {
    expect(() => githubReleaseInfo("[project]", "v1.2.3")).toThrow(
      "Expected project.name to be a non-empty string",
    )
  })
})
