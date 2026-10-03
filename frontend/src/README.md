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
