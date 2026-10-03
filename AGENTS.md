# AGENTS.md

Single publishable ComfyUI custom node pack.

## General

- Runtime code: `frontend/` for frontend, `backend/` for backend, and root `__init__.py` as the thin ComfyUI entry shim.
- Use `uv` for Python dependency sync and execution outside repo scripts.
- Keep agent-specific docs and implementation plans in `docs/agent/`.
- Verify current official docs before ComfyUI API changes.
- In Korean translations, use `,` instead of `·`.

## Validation

- Run `bun run validate:agent` before finishing feature additions or substantial runtime, architecture, node contract, build, or dependency changes. Fix introduced failures and report remaining failures or environment blockers.
- For small documentation, formatting, or localized visual-only changes, validate only when explicitly requested.
- `bun run fix` auto-fixes some lint/format issues. Review the diff and fix remaining issues manually; it does not replace validation.
- See `docs/TESTING.md` for manual runtime testing.

## Frontend

- Keep reusable React components in `frontend/src/components/` and React root components, including pages, modals, and sidebar roots, in `frontend/src/pages/`.
- For React changes, consult `vercel-react-best-practices` and `web-design-guidelines`.
- Use CSS Modules for React components and global CSS for tokens/native DOM islands.
- Define shared runtime values and spacing tokens under `[data-template-theme]` in `frontend/src/styles/globals.css`, not `:root`, to avoid affecting ComfyUI or other extensions; share reusable style rules with `composes`.
- Add `data-template-theme` to this extension's UI root wrappers so React components and native DOM islands inherit the shared tokens. Add it to modal/portal wrappers rendered outside those roots as well.
- Use literal `0` for zero `padding`, `margin`, and `gap`; use `var(--space-*)` for nonzero spacing. Reuse existing tokens first; add shared tokens when needed instead of using literal nonzero spacing values.
- Example spacing scale (extend as needed): `--space-xs` (4px), `--space-sm` (8px), `--space-md` (16px), `--space-lg` (24px), `--space-xl` (32px), `--space-2xl` (48px).
