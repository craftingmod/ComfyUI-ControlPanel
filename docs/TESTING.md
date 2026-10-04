# Testing

## Validation

Run the full repository validation from the repository root:

```shell
bun validate:agent
```

Validation is normally run once after implementation is complete. Do not run the full validation suite repeatedly during development unless needed to diagnose a failure.

`bun test:agent` runs the combined frontend/backend test suite.

## ComfyUI runtime testing

Changes that depend on ComfyUI runtime behavior or native model integration may require manual verification in ComfyUI.

Use the relevant workflow or fixture for the feature being changed and verify only the affected behavior. Automated tests should cover deterministic application logic where practical.

For ComfyUI API changes, verify behavior against the current official ComfyUI documentation.

## Nodes Manager

Restart ComfyUI after updating ControlPanel so the local catalog and Registry-version routes are registered. Open ControlPanel → Nodes Manager and check the catalog source label, search, the five filters, name/star/update sorting, and navigation across the 48-item pages. Click “Choose a version…” to load Registry versions, verify the button shows “Loading versions…” while pending, and confirm the selector appears only after a successful response. On failure, verify the error and Retry button remain available. Check that Flagged versions include their available reason and that the latest version remains the install default. Check installed Git and Registry packs, including disabled packs and packs absent from the catalog.

When ComfyUI-Manager is unavailable, verify the installed-data error and that mutation buttons are disabled. For Manager task UI checks, use a test ComfyUI environment: inspect install, exact-version switch, update, enable, disable, uninstall confirmation, pending/failed/unknown/skipped results, accepted-task queue-start retry, and restart notices. Do not treat an accepted queue request as a completed node change; completion must be confirmed by Manager history and refreshed installed data. No real install or uninstall is required for routine automated validation.

## Generated files

`dist/` is generated from `frontend/`; edit the source files rather than generated output.

Do not create task-specific cache or temporary directories.
