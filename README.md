# ComfyUI-ControlPanel

A lightweight ComfyUI control panel for local administration and workflow metadata repair.

- Update ComfyUI and Git custom nodes, save and restore snapshots, and inspect the local environment.
- Browse and manage custom node packs through Nodes Manager, repair workflow node metadata, and manage cached Manager and Comfy Registry data.
- Bundle the TypeScript frontend with Bun and validate Python with uv, Ruff, and Pytest.

Nodes Manager submits install, update, enable, disable, and uninstall tasks to the installed ComfyUI-Manager. Restart ComfyUI after updating ControlPanel so its new local catalog and Registry-version routes are loaded. Node-pack changes require a ComfyUI restart before updated nodes are available. The catalog uses the ControlPanel SQLite cache first, its legacy JSON cache second, and the existing ComfyUI-Manager Registry cache as a labeled, read-only fallback.

ControlPanel uses the existing backend routes and frontend commands. The template's React sidebar and Normalize Text examples are retained as development references and are not registered at runtime. `old/` is an archived reference, excluded from validation and distribution.

See [DEV.md](./DEV.md) for setup, build, and deployment commands and [docs/TESTING.md](./docs/TESTING.md) for validation and manual checks.

## License

[MIT](./LICENSE), with [third-party notices](./THIRD_PARTY_NOTICES.md).
