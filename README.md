# ComfyUI-ControlPanel

![UI Preview](./docs/static/preview.png)

ComfyUI-ControlPanel restores a few practical control panel workflows that are
not exposed in the modern ComfyUI Manager V4 UI unless the legacy UI is enabled.

The extension is packaged as a single ComfyUI custom node pack. Backend routes
live in `backend/`, the frontend extension lives in `frontend/`, and ComfyUI
loads the built frontend from `dist/index.js` through `WEB_DIRECTORY = "./dist"`.

This custom nodes is built to personal use replacement of [ComfyUI-Manager#3048](https://github.com/Comfy-Org/ComfyUI-Manager/pull/3048).

## Features

- Install a custom node directly from a Git URL.
- Update ComfyUI and Git-installed custom nodes.
- Restart ComfyUI from the control panel.
- Replace the Manager repository cache with a safer and more efficient cache path.

## Install

Install the development dependencies before building or testing:

```bash
pnpm install
uv sync --locked --group dev
```

For local ComfyUI usage, build the frontend once after installing dependencies:

```bash
pnpm build
```

## Development

```bash
pnpm dev
pnpm typecheck
pnpm test
pnpm test:unit
pnpm test:e2e
```

`pnpm test:e2e` builds the frontend, provisions a scoped ComfyUI install, and runs the Playwright smoke suite.

## Release

Publishing is handled by the `Publish to Comfy registry` GitHub Actions workflow.
Run it manually from the `main` branch, choose a patch/minor/major bump, and make
sure the repository has a `REGISTRY_ACCESS_TOKEN` secret.

The workflow:

1. Runs typecheck, tests, and a frontend build.
2. Bumps the version in `pyproject.toml`, `package.json`, and `frontend/src/index.ts`.
3. Creates and pushes a `vX.Y.Z` tag.
4. Checks out that tag, runs `pnpm build`, and publishes the custom node to the registry.

### About `dist/index.js` in tag releases

`dist/` is intentionally ignored by Git, so GitHub's automatic source archives
for tags do not contain `dist/index.js`. The registry release still includes the
built frontend because the publish job runs `pnpm build` after checking out the
tag and before calling `Comfy-Org/publish-node-action`.

If a GitHub tag source archive itself must be directly installable, include a
prebuilt artifact instead of relying on the automatic source archive. Two common
options are:

- Commit `dist/index.js` before creating the release tag, using `git add -f dist/index.js`.
- Create a release zip in CI after `pnpm build` and upload that zip as a GitHub
  Release asset.

## Docs

- [Testing](docs/TESTING.md)

## License

MIT because template was MIT.
