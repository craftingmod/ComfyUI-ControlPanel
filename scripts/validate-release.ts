import fs from "node:fs/promises"
import path from "node:path"

export async function validateRelease(
  root = path.resolve(import.meta.dir, ".."),
): Promise<string[]> {
  const metadata = Bun.TOML.parse(await fs.readFile(path.join(root, "pyproject.toml"), "utf8")) as {
    project: { name: string; urls: { Repository: string } }
    tool: { comfy: { PublisherId: string; DisplayName: string; Icon: string } }
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
  const project = metadata.project as { name: string; urls: { Repository: string } }
  const comfy = (
    metadata.tool as { comfy: { PublisherId: string; DisplayName: string; Icon: string } }
  ).comfy
  const errors: string[] = []
  if (packageJson.name !== project.name)
    errors.push("package.json and Python project names must match.")
  for (const [field, value] of Object.entries({
    name: project.name,
    Repository: project.urls.Repository,
    PublisherId: comfy.PublisherId,
    DisplayName: comfy.DisplayName,
    Icon: comfy.Icon,
  })) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      /your-name|your-repo|your-username|comfyui-custom-node-template/i.test(value)
    ) {
      errors.push(`${field} must contain initialized project metadata.`)
    }
  }
  if (
    process.env.GITHUB_REPOSITORY &&
    project.urls.Repository.toLowerCase() !==
      `https://github.com/${process.env.GITHUB_REPOSITORY}`.toLowerCase()
  ) {
    errors.push("Repository metadata must match GITHUB_REPOSITORY.")
  }
  return errors
}

if (import.meta.main) {
  const errors = await validateRelease()
  if (errors.length) throw new Error(errors.join("\n"))
  console.log("Release metadata is valid.")
}
