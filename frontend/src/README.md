## frontend/src

## Context

`ComfyUI` + `DOM (browser native)` Context

## Purpose

Contains the frontend extension that runs inside the ComfyUI browser UI. Use
the ComfyUI `app` and `api` modules from `../../scripts/app.js` and
`../../scripts/api.js` together with native browser DOM APIs here to register
extensions, settings, commands, widgets, and other UI behavior.

React components live in `.tsx` files using the automatic JSX runtime. See
`react-sidebar.tsx` for a `createRoot()` example with explicit `unmount()` cleanup.
React owns only its container; keep saved workflow state in the node/controller.

Import component styles from `.module.css` files. `bun run build:css-type` generates
their class declarations in `frontend/.generated/`, and `typecheck` runs it first.
The entry installs the emitted `dist/index.css` through `stylesheet.ts`.

`styles/globals.css` owns root spacing tokens, inherited theme/runtime tokens,
and scoped native-note rules. Reuse `var(--space-*)`
for every padding, margin, and gap; define new shared spacing tokens in globals
when needed. The React sidebar's two buttons compose `controlBase` from
`styles/controls.module.css`. Its imperative note is a sibling of the React host
under `[data-template-theme]`, so both inherit tokens without sharing DOM ownership.

## Directory Structure

- `components/`: React components with reuseable
- `pages/`: A root react page/component with not reuseable
- `styles/`: common styles which uses across components.
