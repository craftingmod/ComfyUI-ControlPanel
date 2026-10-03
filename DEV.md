# Development

This repository adopts the tooling from
[craftingmod/comfyui-custom-node-template](https://github.com/craftingmod/comfyui-custom-node-template)
at `297af998486808c8bf24f7f059e5f1c1d55e4ed1`.

Use Python 3.12+, uv, Node.js 24, system pnpm 11.10, and Bun 1.4.2.
Clone with Git history and version tags. Hatchling and uv-dynamic-versioning
derive the Python and Registry versions from Git; no static version bump is needed.

```shell
pnpm install --frozen-lockfile
uv sync --locked --group dev
pnpm typecheck
pnpm test:unit
pnpm lint
pnpm build
pnpm dev
```

`verifyDepsBeforeRun` is disabled. Bun builds the browser ESM bundle and runs
tooling scripts. Vitest retains the existing isolated module/global mocks.
The current native DOM UI, settings IDs, backend routes, and startup hooks stay
owned by ControlPanel. The template's example node and React sidebar are omitted.
Styles remain injected into the existing style element; the build imports ComfyUI
from `/scripts/app.js` and does not bundle a second ComfyUI app.

## Local deployment

Copy `.env.example` to `.env.local` and set an absolute `COMFYUI_PATH`.

```shell
pnpm setup:local
pnpm deploy:dev
pnpm dev
```

`setup:local` adds the ComfyUI path to ignored Pylance settings. `deploy:dev`
creates or reuses a link to this checkout; on Windows it uses a junction.
Reload the browser after frontend builds and restart ComfyUI after Python changes.
`pnpm deploy:local` builds and replaces the installed directory with the packaged
files, staging the replacement first. Run it only when that replacement is intended.

## Validation and release

```shell
pnpm validate
pnpm fmt:check
pnpm release:check
pnpm build:custom-node
```

The ZIP is written to `build/ComfyUI-ControlPanel-<Git-version>.zip` with package
files at its root. Extract into a dedicated directory under `custom_nodes/`.
`backend/_version.py` is generated for Registry publishing and ignored by Git.
The older `scripts/New-CustomNodesZip.ps1` remains available for the ZIP format
with a top-level `ComfyUI-ControlPanel/` directory.

`pnpm version:bump` creates a patch tag only from a clean stable version; with
uncommitted changes it prints instructions. CI runs validation and packaging on
main-branch pushes and pull requests. The release workflow reuses CI before
publishing a `v*` tag. Set `REGISTRY_ACCESS_TOKEN` for the `alyac` publisher.

See [docs/TESTING.md](docs/TESTING.md) for automated and live verification.
