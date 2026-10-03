import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const runDirectory = join(root, ".ci-test-tmp", randomUUID())
const environment = { ...process.env, TMP: runDirectory, TEMP: runDirectory, TMPDIR: runDirectory }

async function run(command: string[]): Promise<number> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

mkdirSync(runDirectory, { recursive: true })
let exitCode = 0
try {
  exitCode = await run(["pnpm", "test:tooling"])
  if (exitCode === 0) exitCode = await run(["pnpm", "test:frontend"])
  if (exitCode === 0) {
    exitCode = await run([
      "uv",
      "run",
      "pytest",
      "tests/python",
      "tests/backend",
      "-q",
      "-p",
      "no:cacheprovider",
      `--basetemp=${join(runDirectory, "pytest")}`,
    ])
  }
} finally {
  rmSync(runDirectory, { recursive: true, force: true })
}
process.exit(exitCode)
