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

## Generated files

`dist/` is generated from `frontend/`; edit the source files rather than generated output.

Do not create task-specific cache or temporary directories.
