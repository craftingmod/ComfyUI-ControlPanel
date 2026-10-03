# Development

## Requirements

- Python 3.12
- [uv](https://docs.astral.sh/uv/)
- Bun 1.4+

Clone the repository with its Git history and tags, then install dependencies:

```shell
bun install --frozen-lockfile
uv sync --locked --group dev
```

Hatchling and `uv-dynamic-versioning` derive the version from Git tags. A new
repository needs an initial tag, such as `git tag v0.1.0`, before `uv sync` or
builds will work. `strict = true` makes a missing version tag an error.

## Template references

This repository is already initialized as ComfyUI-ControlPanel. `init:template`
renames template examples and package metadata; it is only useful when creating a
separate project, not for migrating this extension. The React sidebar and Python
Normalize Text example are retained as references without runtime registration.
`old/` is excluded from current tests, lint, formatting, and release archives.

## Local ComfyUI development

Copy `.env.example` to `.env.local` and set `COMFYUI_PATH` to your ComfyUI
installation's absolute path. Configure Pylance with:

```shell
bun run setup:local
```

This sets `python.analysis.extraPaths` in the ignored `.vscode/settings.json` and
preserves other settings. Pass `--comfyui-path <path>` to override the path for
one invocation.

Build the frontend and link this repository into `custom_nodes/<project.name>`:

```shell
bun run deploy:dev
```

On Windows, this creates a directory junction. An existing link to this repository
is reused; an existing directory or link elsewhere is left alone.

Watch frontend changes with:

```shell
bun run dev
```

Reload the browser after a rebuild. Restart ComfyUI after Python changes.

To test the packaged files, run:

```shell
bun run deploy:local
```

This replaces `custom_nodes/<project.name>` with the built package. Files are
staged before the swap, so a failed build leaves the installed package in place.

## Source layout

- `backend/`: V3 nodes. Register them in `TemplateExtension.get_node_list()` in
  `backend/__init__.py`.
- `frontend/src/components/`: reusable React components.
- `frontend/src/pages/`: React roots, including pages, modals, and sidebars.
- `frontend/src/index.ts`: frontend extension registration.
- `dist/`: generated frontend bundle.

The root `__init__.py` exposes `comfy_entrypoint()` and `WEB_DIRECTORY = "./dist"`.

See [docs/TESTING.md](docs/TESTING.md) for validation and runtime testing.

## React UI

The example sidebar is in `frontend/src/pages/react-sidebar.tsx`. Replace it or
remove its registration in `frontend/src/index.ts`.

`@/` resolves to `frontend/src/` in TypeScript, Bun builds, and tests. For example,
import a component from `@/components/Button.tsx` or constants from `@/constants.ts`.
CSS Module imports can use the same alias; their types come from
`frontend/.generated/`.

Each React root owns its host and unmounts when the sidebar is destroyed or
rendered again. Keep workflow values and serialization in the node/controller.
Use React state for local UI interactions. The example's native DOM note sits
outside the React host and is removed with the sidebar shell.

### Styles

Use `.module.css` files for components and `frontend/src/styles/globals.css` for
shared tokens and native DOM styles. Use `0` for zero spacing and `var(--space-*)`
for nonzero padding, margin, and gap. Add a shared token when needed.

Declare shared tokens under `[data-template-theme]`, not `:root`, to avoid
affecting ComfyUI or other extensions. Add `data-template-theme` to each UI root
wrapper so React components and native DOM islands inherit the tokens. Modal or
portal wrappers rendered outside those roots need the attribute as well.

Share CSS rules with `composes`; `frontend/src/styles/controls.module.css` has the
button example. Pass composed class strings directly to React's `className`.

### Build

React and ReactDOM are bundled into `dist/index.js`; `app` and `api` come from
ComfyUI. `bun run build` uses React's production runtime. `bun run dev` uses the
development runtime with source maps.

`typecheck`, `build`, and `dev` generate CSS declarations in `frontend/.generated/`.
After adding or renaming classes while watching, run `bun run build:css-type`.
Use `bun run build:css-type --check` to check declarations without writing them.

Bun bundles styles into `dist/index.css`, loaded by `frontend/src/stylesheet.ts`.
The normal lint commands include Stylelint; `bun run lint:css` runs it separately.
Scope native DOM styles with data attributes, as the example does with
`[data-template-theme]` and `[data-template-native-note]`.

## Package and publish

Build the package:

```shell
bun run build:custom-node
```

The ZIP is written to `build/<DisplayName>-<version>.zip`. This template's
`.comfyignore` excludes everything except the listed runtime files and metadata.
`[tool.comfy].includes` adds the generated `dist/` and `backend/_version.py` files.
The version file is used by Registry publishing. Versions between tags include
suffixes such as `.post7.dev0+<commit>`.

From a stable Git version and a clean working tree, create the next patch tag with:

```shell
bun run version:bump
```

This creates a tag at the current commit without changing `pyproject.toml` or
`uv.lock`. With a dirty working tree, it only prints the proposed tag. Development
versions are rejected; commit your changes and tag the release manually instead.

Before publishing, check the project metadata:

```shell
bun run release:check
```

Replace the template placeholders and set `REGISTRY_ACCESS_TOKEN` in GitHub
Actions secrets. Pushing a `v*` tag runs validation, publishes to Comfy Registry,
and creates a GitHub Release with the ZIP. `workflow_dispatch` runs validation
and Registry publishing without creating a GitHub Release.
