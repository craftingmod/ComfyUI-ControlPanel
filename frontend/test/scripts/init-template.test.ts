import { expect, it } from "bun:test"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import Path from "node:path"

import { initializeTemplate, validateProjectName } from "@scripts/init-template.ts"

it("accepts Unicode display names and rejects embedded control characters", () => {
  expect(validateProjectName("  한글 👨‍👩‍👧‍👦  ")).toBe("한글 👨‍👩‍👧‍👦")
  expect(() => validateProjectName("name\u0000node")).toThrow("without control characters")
  expect(() => validateProjectName("name\u007fnode")).toThrow("without control characters")
  for (const name of ["Image: Tools", "Image/Tools", "Image\\Tools", 'Image "Tools"']) {
    expect(() => validateProjectName(name)).toThrow("invalid filename characters")
  }
})

it("initializes current project files while preserving dynamic version and alias configuration", async () => {
  const repository = Path.resolve(import.meta.dir, "../../..")
  const projectRoot = await fs.mkdtemp(Path.join(tmpdir(), "comfyui-test-"))
  const paths = [
    "pyproject.toml",
    "package.json",
    "frontend/src/constants.ts",
    "backend/nodes/example_normalize_text.py",
    "README.md",
    "frontend/src/tsconfig.json",
    "frontend/test/tsconfig.json",
  ]
  try {
    for (const file of paths) {
      const destination = Path.join(projectRoot, file)
      await fs.mkdir(Path.dirname(destination), { recursive: true })
      await fs.copyFile(Path.join(repository, file), destination)
    }
    const originalConfig = Bun.TOML.parse(
      await Bun.file(Path.join(projectRoot, "pyproject.toml")).text(),
    ) as {
      project: { urls: Record<string, unknown> }
      tool: { comfy: Record<string, unknown> }
    }
    const invalidNameError = await initializeTemplate(
      "image-tools",
      "Image: Tools",
      "octocat",
      "image-tools",
      "octocat",
      projectRoot,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(invalidNameError).toMatchObject({
      message: "tool.comfy.DisplayName contains invalid filename characters",
    })
    expect(await Bun.file(Path.join(projectRoot, "pyproject.toml")).text()).toBe(
      await Bun.file(Path.join(repository, "pyproject.toml")).text(),
    )

    const projectName = "이미지 도구 $&"
    await initializeTemplate(
      " image-tools ",
      projectName,
      "octocat",
      "image-tools",
      "octocat",
      projectRoot,
    )
    const config = Bun.TOML.parse(await Bun.file(Path.join(projectRoot, "pyproject.toml")).text())
    expect(config).toEqual({
      ...originalConfig,
      project: {
        ...originalConfig.project,
        name: "image-tools",
        urls: {
          ...originalConfig.project.urls,
          Repository: "https://github.com/octocat/image-tools",
        },
      },
      tool: {
        ...originalConfig.tool,
        comfy: {
          ...originalConfig.tool.comfy,
          DisplayName: projectName,
          PublisherId: "octocat",
          Icon: "https://cdn.jsdelivr.net/gh/octocat/image-tools/assets/icon.svg",
        },
      },
    })
    expect(config).not.toHaveProperty("project.version")
    expect((await Bun.file(Path.join(projectRoot, "package.json")).json()).name).toBe("image-tools")
    for (const file of ["frontend/src/constants.ts", "backend/nodes/example_normalize_text.py"]) {
      const source = await Bun.file(Path.join(projectRoot, file)).text()
      expect(source).toContain('PROJECT_ID = "image-tools"')
      expect(source).toContain(`PROJECT_NAME = "${projectName}"`)
    }
    expect(await Bun.file(Path.join(projectRoot, "README.md")).text()).toBe(
      (await Bun.file(Path.join(repository, "README.md")).text()).replace(
        /^# .+$/m,
        () => `# ${projectName}`,
      ),
    )
    for (const file of ["frontend/src/tsconfig.json", "frontend/test/tsconfig.json"]) {
      expect(await Bun.file(Path.join(projectRoot, file)).text()).toBe(
        await Bun.file(Path.join(repository, file)).text(),
      )
    }
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true })
  }
})
