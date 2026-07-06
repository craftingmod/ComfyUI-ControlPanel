# Changelog

## v1.1.3 - Changes since v1.0.1

This release expands the panel with the remaining local Manager-style workflows
that are not exposed in the modern ComfyUI Manager UI.

### Highlights

- Added Manager cache update and rebuild actions.
- Added snapshot save/restore through the Comfy CLI.
- Added buttons to open the `custom_nodes` and Manager snapshots folders.
- Added Comfy CLI environment viewer using `comfy --json env`.
- Added status JSON inspection and local log clearing.
- Added grouped panel sections and renamed the action bar button to `Panel`.
- Added localhost-only protection for all `/control-panel/*` routes by default.
- Added `allow_remote_control` config option for trusted private deployments.
- Added startup/security warnings for remote-control configuration and blocked remote requests.

### Packaging

- Release zip assets now include the built `dist/index.js`.
- Zip file names keep the version, for example `ComfyUI-ControlPanel-v1.1.3.zip`.
- Zip contents now use a stable top-level folder: `ComfyUI-ControlPanel/`.
- Release packaging removes `__pycache__` and `*.py[co]` files.

### Internal

- Split the backend into smaller modules for routes, jobs, process execution,
  cache handling, settings, Git operations, CLI response handling, and runtime helpers.
- Added timestamp-based incremental Comfy Registry cache refresh.
- Fixed Manager cache hashing when a fresh cache file already exists.
