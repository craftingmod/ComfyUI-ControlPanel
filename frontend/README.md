## frontend

## Context

`bun` Context

## Purpose

Contains the Bun-based frontend tooling. `build.ts` bundles the browser entry
into `dist/`, while `dev.ts` watches the frontend source and rebuilds it during
development. Use Bun and Node-compatible APIs here; browser DOM APIs are not
available in this context.
