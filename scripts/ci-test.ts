import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const runDirectory = join(root, ".ci-cache", randomUUID())
const showDots = !process.argv.includes("--no-dots")
const environment = {
  ...process.env,
  UV_CACHE_DIR: join(root, ".ci-cache", "uv"),
  RUFF_CACHE_DIR: join(root, ".ci-cache", "ruff"),
  TMP: runDirectory,
  TEMP: runDirectory,
  TMPDIR: runDirectory,
}

async function run(command: string[], label: string): Promise<number> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  })

  const exitCode = await child.exited
  console.log(`[ci:test] ${label}: ${exitCode === 0 ? "passed" : `failed (exit ${exitCode})`}`)
  return exitCode
}

mkdirSync(runDirectory, { recursive: true })

let exitCode = 0

try {
  exitCode = await run(
    [
      "bun",
      "test",
      ...(showDots ? ["--dots"] : []),
      "--preload",
      "./frontend/test/setup.ts",
      "--parallel",
      "./frontend/test",
    ],
    "frontend",
  )
  if (exitCode === 0) {
    exitCode = await run(
      [
        "uv",
        "run",
        "pytest",
        "-n",
        "auto",
        "tests/python",
        "tests/backend",
        "-q",
        `--basetemp=${join(runDirectory, "pytest")}`,
        "-p",
        "no:cacheprovider",
      ],
      "backend",
    )
  }
} finally {
  rmSync(runDirectory, { recursive: true, force: true })
}

process.exit(exitCode)
