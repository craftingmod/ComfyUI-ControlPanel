# ComfyUI-ControlPanel

![Icon](./assets/icon.svg)

ComfyUI-ControlPanel restores a few practical control panel workflows that are
not exposed in the modern ComfyUI Manager V4 UI unless the legacy UI is enabled.

The extension is packaged as a single ComfyUI custom node pack. Backend routes
live in `backend/`, the frontend extension lives in `frontend/`, and ComfyUI
loads the built frontend from `dist/index.js` through `WEB_DIRECTORY = "./dist"`.

This custom node pack is primarily maintained as a personal-use replacement for
[ComfyUI-Manager#3048](https://github.com/Comfy-Org/ComfyUI-Manager/pull/3048).

## Features

![Panel Preview](./assets/panel.webp)

- Install a custom node directly from a Git URL.
- Update ComfyUI and Git-installed custom nodes without enabling the legacy Manager UI.
- Replace the Manager repository cache with a safer and more efficient cache path.
- Update or rebuild the Manager cache when Replace Manager Repository Data is enabled.
- Save and restore Manager snapshots through the Comfy CLI.
- Download a latest-version custom-node restore manifest and restore Registry/Git nodes from an uploaded JSON file.
- Open the `custom_nodes` and Manager snapshots folders from the panel on local installs.
- Show the parsed `comfy --json env` output in a table-style environment dialog.
- Restart ComfyUI from the control panel.
- Inspect the latest status JSON and clear the local operation log.
- Add missing `cnr_id`, `aux_id`, and version metadata when nodes are created or loaded.
- Repair Registry metadata across the active workflow, including nested subgraphs, with one Undo step.

## Requirements

- [`comfy-cli`](https://docs.comfy.org/comfy-cli/getting-started), with the `comfy` command available on `PATH` (in `venv`).
- Git available on `PATH` for Git URL installation, updates, and restore manifests.
- ComfyUI-Manager enabled for Manager cache, snapshot, and Registry metadata features.

## Install

### From the Comfy Registry

Install the published package through ComfyUI Manager, or target the current
ComfyUI workspace with the Comfy CLI:

```bash
comfy node install comfyui-controlpanel
```

Restart ComfyUI after installation.

### From a GitHub Release

As a manual alternative, install from the GitHub Release zip attached to a
version tag, not from GitHub's automatic source archive. The release zip
includes the built frontend file at `dist/index.js`, which ComfyUI needs at
runtime.

For new releases, download the attached asset named like:

```text
ComfyUI-ControlPanel-1.2.6.zip
```

Create the following directory and extract the package files into it:

```text
ComfyUI/custom_nodes/ComfyUI-ControlPanel/
```

Then restart ComfyUI. Older releases contain a top-level `ComfyUI-ControlPanel/`
folder; extract that folder under `custom_nodes/` instead.

### From Source

Install the development dependencies before building or testing from source:

```bash
pnpm install --frozen-lockfile
uv sync --locked --group dev
```

For local ComfyUI usage, build the frontend once after installing dependencies:

```bash
pnpm build
```

## Security Model

ComfyUI-ControlPanel is local-first. ComfyUI does not provide a built-in user or
permission model for custom node HTTP routes, so the panel treats loopback access
as the default trust boundary.

By default, all `/control-panel/*` routes and the frontend panel UI are available
only to localhost clients such as `localhost`, `127.0.0.1`, and `::1`. This is
intentional because the panel can install Git repositories, update custom nodes,
restore snapshots, open local folders, and restart ComfyUI.

When remote control is disabled, both the connection peer and HTTP `Host` must be
loopback. This prevents an external hostname routed through a local reverse proxy
or DNS rebinding from being treated as ordinary localhost access.

State-changing requests must also be same-origin. Requests without an `Origin`
header are accepted only from loopback clients so local command-line tools remain
usable. ControlPanel follows ComfyUI-Manager's operation policy: Git URL installs
require `allow_git_url_install = true` when Manager's `config.ini` is present,
middle-risk operations such as custom-node updates, snapshot restore, and restart
are blocked by `security_level = strong`, and ComfyUI updates remain low-risk
operations. When Manager's configuration is absent, ControlPanel remains usable
with its own access and same-origin checks rather than requiring Manager.

Commands that install or update code, restore state, or restart ComfyUI run only
after an explicit user action in the panel; loading a workflow does not execute
them. External commands are launched with argument arrays rather than shell
command strings. Custom nodes are installed without dependencies while ComfyUI
is running, and dependency reconciliation is delegated to `comfy node uv-sync`
after ComfyUI is closed. ComfyUI core updates and their requirements are
delegated to the official Comfy CLI updater.

To allow remote clients on a trusted private deployment, set this in the
ControlPanel config file under the ComfyUI user directory:

```json
{
  "allow_remote_control": true
}
```

Do not enable remote control for ComfyUI instances exposed to untrusted networks.
Enabling it deliberately transfers responsibility for authenticating and
protecting remote clients to the operator; browser requests must still be
same-origin and all Manager operation policies continue to apply.

## Development

```bash
pnpm dev
pnpm typecheck
pnpm test
pnpm test:unit
```

`pnpm test` runs the frontend and backend unit test suites.

The backend is split by responsibility:

- `backend/manager_api.py` keeps the ComfyUI-facing compatibility facade.
- `backend/manager_routes.py` registers HTTP routes.
- `backend/manager_jobs.py` tracks background update jobs.
- `backend/manager_process.py` runs external commands and opens local folders.
- `backend/manager_cache.py` handles Manager and Comfy Registry cache data.
- `backend/registry_cache.py` owns the [SQLite Registry catalog and installed-version summaries](docs/REGISTRY_CACHE.md).
- `backend/manager_settings.py` reads and writes ControlPanel/Manager settings.
- `backend/manager_git.py` handles Git-based update flows.
- `backend/manager_cli.py` formats Comfy CLI responses.
- `backend/manager_runtime.py` handles runtime paths and restart helpers.

See [DEV.md](DEV.md) for the Bun build, template deployment tooling, and Git
version requirements.

## Release

Version tags publish the same built extension to the Comfy Registry and to a
GitHub Release zip. Add a repository Actions secret named
`REGISTRY_ACCESS_TOKEN` containing the publishing key for the `alyac` Registry
publisher before creating a release tag.

Versions are derived from Git tags using Hatchling and uv-dynamic-versioning.
Clone with Git history and tags; source archives alone cannot resolve the version.
The private frontend package has no independent version. From a clean stable
release commit, `pnpm version:bump` creates the next patch tag; with a dirty
working tree it prints instructions instead. Push the intended tag to publish.

```bash
pnpm release:check
pnpm build:custom-node
```

The template ZIP is written to `build/ComfyUI-ControlPanel-<version>.zip`.
Create a `ComfyUI-ControlPanel/` directory under `custom_nodes/` and extract its
contents there. The existing PowerShell archive command remains available for
users who need the older ZIP with a top-level directory.

The release workflow first runs CI validation, then publishes to the Registry
and creates a GitHub Release with the built ZIP. CI checks out all Git history,
installs system pnpm, Bun and uv, validates the project, and builds the package.

### About `dist/index.js` in tag releases

`dist/` is intentionally ignored by Git. The Registry workflow builds it before
publishing, and `[tool.comfy].includes` forces it into the Registry package. The
GitHub automatic source archives still omit `dist/index.js`, so manual installs
must use the attached release zip instead.

CI runs on main-branch pushes and pull requests, and is reused by releases.

### v1.1.0 notes

`v1.1.0` is expected to be released from a tag-built GitHub Release artifact.
Compared with the early `v1.0.0` shape, the control panel now includes Manager
cache rebuild/update actions, snapshot save/restore, local folder open actions,
Comfy CLI environment display, status JSON inspection, and a modularized backend
implementation.

## Docs

- [Testing](docs/TESTING.md)

## License

MIT because template was MIT.
