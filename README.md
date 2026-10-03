# ComfyUI-ControlPanel

A lightweight ComfyUI control panel for local administration and workflow metadata repair.

- Update ComfyUI and Git custom nodes, save and restore snapshots, and inspect the local environment.
- Repair workflow node metadata and manage cached Manager and Comfy Registry data.
- Bundle the TypeScript frontend with Bun and validate Python with uv, Ruff, and Pytest.

ControlPanel uses the existing backend routes and frontend commands. The template's React sidebar and Normalize Text examples are retained as development references and are not registered at runtime. `old/` is an archived reference, excluded from validation and distribution.

See [DEV.md](./DEV.md) for setup, build, and deployment commands and [docs/TESTING.md](./docs/TESTING.md) for validation and manual checks.

## License

[MIT](./LICENSE), with [third-party notices](./THIRD_PARTY_NOTICES.md).
