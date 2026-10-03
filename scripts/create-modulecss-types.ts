import fs from "node:fs/promises"
import path from "node:path"

import { parse, walk } from "@tbela99/css-parser"

type Options = {
  check: boolean
  outDir: string
  sourceDir: string
}

const projectDir = path.resolve(import.meta.dir, "..")

function parseOptions(args: string[]): Options {
  const options: Options = {
    check: false,
    outDir: path.join(projectDir, "frontend/.generated"),
    sourceDir: path.join(projectDir, "frontend/src"),
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--check") {
      options.check = true
    } else if (argument === "--out-dir") {
      options.outDir = path.resolve(projectDir, args[++index] ?? "")
    } else if (argument === "--source-dir") {
      options.sourceDir = path.resolve(projectDir, args[++index] ?? "")
    } else if (argument === "--help") {
      console.log(
        "Usage: bun scripts/create-modulecss-types.ts [--check] [--source-dir DIR] [--out-dir DIR]",
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  return options
}

export async function collectClassNames(css: string): Promise<string[]> {
  const classNames = new Set<string>()
  const { ast } = await parse(css)

  for (const { node } of walk(ast)) {
    if ("sel" in node && typeof node.sel === "string") {
      for (const match of node.sel.matchAll(/(?:^|[^\\\w-])\.([A-Za-z_][\w-]*)/g)) {
        classNames.add(match[1]!)
      }
    }
  }

  return [...classNames].sort()
}

export function renderDeclaration(classNames: string[]): string {
  const properties = classNames
    .map((className) => {
      const property = /^[A-Za-z_$][\w$]*$/.test(className) ? className : JSON.stringify(className)
      return `  readonly ${property}: string`
    })
    .join("\n")

  return `// Auto generated. DO NOT EDIT\ndeclare const styles: {\n${properties}\n}\nexport default styles\n`
}

async function readFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await readFiles(entryPath)))
    } else if (entry.isFile() && entry.name.endsWith(".module.css")) {
      files.push(entryPath)
    }
  }
  return files
}

async function generatedFiles(directory: string): Promise<string[]> {
  try {
    const files: string[] = []
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await generatedFiles(entryPath)))
      } else if (entry.isFile() && entry.name.endsWith(".d.css.ts")) {
        files.push(entryPath)
      }
    }
    return files
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2))
  const cssFiles = await readFiles(options.sourceDir)
  const expected = new Map<string, string>()

  for (const cssFile of cssFiles) {
    const relativePath = path.relative(options.sourceDir, cssFile)
    const outputPath = path.join(options.outDir, relativePath.replace(/\.css$/, ".d.css.ts"))
    const css = await fs.readFile(cssFile, "utf8")
    const safeCss = css.replace(/\s*composes:.*?;/g, "--compose-placeholder: 0;")

    expected.set(outputPath, renderDeclaration(await collectClassNames(safeCss)))
  }

  const actual = new Set(await generatedFiles(options.outDir))
  const differences: string[] = []

  for (const [outputPath, content] of expected) {
    const current = await fs.readFile(outputPath, "utf8").catch(() => null)
    if (current !== content) differences.push(path.relative(projectDir, outputPath))
    actual.delete(outputPath)
    if (!options.check) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, content)
    }
  }

  for (const stalePath of actual) {
    differences.push(path.relative(projectDir, stalePath))
    if (!options.check) await fs.rm(stalePath)
  }

  if (options.check && differences.length > 0) {
    throw new Error(
      `CSS module declarations are out of date:\n${differences.map((file) => `- ${file}`).join("\n")}`,
    )
  }

  console.log(
    `${options.check ? "Checked" : "Generated"} ${expected.size} CSS module declaration(s).`,
  )
}

if (import.meta.main) await main()
