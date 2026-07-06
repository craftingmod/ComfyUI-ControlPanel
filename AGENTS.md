# AGENTS.md

Single publishable ComfyUI custom node pack.

- Frontend runtime code lives in `frontend/`
- Backend node code lives in `backend/`
- Root `__init__.py` is the thin ComfyUI entry shim
- Use repo commands first: `pnpm typecheck`, `pnpm test`, `pnpm test:unit`, `pnpm test:e2e`
- Use `uv` for Python dependency sync and Python execution outside repo scripts

For testing details, see `docs/TESTING.md`.
For ComfyUI API changes, verify current official docs before changing architecture or advanced frontend hooks.

## pnpm warning
Use system pnpm, NOT codex built-in pnpm!
It causes 

## About CSS
ComfyUI supports tailwindcss so tailwindcss style is preferred.

## Useful Commands

1. Check type in typescript
```sh
pnpm run typecheck
```

2. Lint frontend code
```sh
pnpm run eslint
```
 * Lint with fix
 ```sh
pnpm run eslint:fix
 ```

3. Build frontend
```sh
pnpm run build
```
