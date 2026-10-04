## frontend/src

## Context

`ComfyUI` + `DOM (browser native)` Context

## Purpose

Contains the frontend extension that runs inside the ComfyUI browser UI. Use
the ComfyUI `app` and `api` modules from `../../scripts/app.js` and
`../../scripts/api.js` together with native browser DOM APIs here to register
extensions, settings, commands, widgets, and other UI behavior.

React components live in `.tsx` files using the automatic JSX runtime. The
ControlPanel page is mounted by `components/controlPanel.ts`; its React root
stays alive while the Panel is closed so logs and modal input values survive
reopening. The controller owns API calls, metadata repair, and update polling;
React owns the rendered Panel and modal DOM. `react-sidebar.tsx` remains an
unregistered example.

The ControlPanel controller also owns one Nodes Manager controller for the
React root's lifetime. Opening Nodes Manager loads the local Registry catalog
and installed-node list; closing either dialog stops polling and ignores stale
reads. React owns filters, search, sorting, pagination, and the selected
Registry version, while the manager controller owns catalog data, operations,
and Manager queue state. Catalog reads prefer ControlPanel SQLite, then the
legacy ControlPanel JSON cache, then the existing ComfyUI-Manager Registry
cache as a labeled, read-only fallback. Restart ComfyUI after updating
ControlPanel to load the new backend routes.

Import component styles from `.module.css` files. `bun run build:css-type` generates
their class declarations in `frontend/.generated/`, and `typecheck` runs it first.
The entry installs the emitted `dist/index.css` through `stylesheet.ts`.

`styles/globals.css` owns inherited theme/runtime tokens and scoped native-note
rules. Reuse `var(--space-*)` for every padding, margin, and gap; define new
shared spacing tokens there when needed. The ControlPanel CSS Module composes
its buttons from `styles/controls.module.css` and is loaded with `stylesheet.ts`.

## Directory Structure

- `components/`: React components with reuseable
- `pages/`: A root react page/component with not reuseable
- `styles/`: common styles which uses across components.
