# Changelog

## Unreleased


## v1.2.4

- Made `pyproject.toml` the single release-version source and documented `uv version` for synchronized lockfile updates.
- Reduced tag publishing to frontend build and release-artifact validation; unit suites remain available through the separate CI workflow.
- Preserved the generated `dist` directory when publishing to the Comfy Registry so Registry and GitHub release archives include the frontend bundle.

## v1.2.0

- Removed the non-functional Playwright/ComfyUI E2E harness and simplified `pnpm test` to the unit suites.
- Added tag-based Comfy Registry publishing, package version checks, and a runtime-focused `.comfyignore`.
- Added browser-downloaded custom-node restore manifests using compact Registry IDs and Git URLs.
- Recorded installed Registry versions and current Git commits in node restore manifests while keeping restoration latest-version based.
- Added browser-uploaded latest-version restoration through `comfy node install` and `git clone`.
- Added dependency-free Registry restoration and a post-restore notice to close ComfyUI and run `comfy node uv-sync` instead of modifying the active runtime.
- Removed obsolete direct `uv pip install` update paths; Git node updates now request a stopped `comfy node uv-sync` dependency pass.
- Added informational unmanaged-folder entries for custom nodes that cannot be restored automatically.

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
