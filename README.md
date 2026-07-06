# ComfyUI-ControlPanel

![UI Preview](./docs/static/preview.png)

ComfyUI-ControlPanel restores a few practical control panel workflows that are
not exposed in the modern ComfyUI Manager V4 UI unless the legacy UI is enabled.

Current features:

- Install a custom node directly from a Git URL.
- Update ComfyUI & Nodes (downloaded via git)
- Restart
- Replace repository cache to efficient, safe way.

## Install

```bash
pnpm install
uv sync --locked --group dev
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

## Docs

- [Testing](docs/TESTING.md)

### TODO

Add `REGISTRY_ACCESS_TOKEN` in GitHub and run the `Publish to Comfy registry` workflow.

## License

MIT because template was MIT.