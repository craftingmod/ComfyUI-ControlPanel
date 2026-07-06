# ComfyUI-ControlPanel

![UI Preview](./docs/static/preview.png)

ComfyUI-ControlPanel restores a few practical control panel workflows that are
not exposed in the modern ComfyUI Manager V4 UI unless the legacy UI is enabled.

The extension is packaged as a single ComfyUI custom node pack. Backend routes
live in `backend/`, the frontend extension lives in `frontend/`, and ComfyUI
loads the built frontend from `dist/index.js` through `WEB_DIRECTORY = "./dist"`.

This custom node pack is primarily maintained as a personal-use replacement for
[ComfyUI-Manager#3048](https://github.com/Comfy-Org/ComfyUI-Manager/pull/3048).

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

Publishing to the Comfy Registry is intentionally not automated. Releases are
GitHub Release zip artifacts built from version tags.

Create and push a version tag to publish an installable zip:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The release workflow:

1. Checks out the tagged source.
2. Installs dependencies with Node.js 24, pnpm, and uv.
3. Runs typecheck and unit tests.
4. Builds the frontend.
5. Verifies that `dist/index.js` exists.
6. Uploads `ComfyUI-ControlPanel-vX.Y.Z.zip` to the GitHub Release.

### About `dist/index.js` in tag releases

`dist/` is intentionally ignored by Git, so GitHub's automatic source archives
for tags do not contain `dist/index.js`. Use the attached release zip instead;
it is created after `pnpm build` and includes the required `dist/index.js` file.

## Docs

- [Testing](docs/TESTING.md)

## License

MIT because template was MIT.
