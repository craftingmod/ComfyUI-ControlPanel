# Testing

## Commands

```bash
pnpm test
pnpm test:unit
pnpm test:frontend
pnpm test:backend
pnpm test:watch
pnpm test:coverage
```

## Coverage

- `pnpm test` and `pnpm test:unit` run the frontend and backend unit test suites.
- `pnpm test:frontend` runs the Vitest frontend suite.
- `pnpm test:backend` runs the pytest backend suite.
- `pnpm test:watch` runs Vitest in watch mode.
- `pnpm test:coverage` generates frontend unit-test coverage.

`pnpm test:unit` uses a unique repository-local temporary directory for both
suites and disables pytest's cache provider. Tests remain sequential to preserve
the existing backend fixtures and frontend mock isolation.
It also runs the template tooling tests with Bun before the existing suites.

## Migration checks

Run `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm build`, and
`pnpm release:check`. Use `pnpm build:custom-node` to check the generated package.
The frontend uses Bun build/watch and Vitest tests; `pnpm eslint` is a compatibility
alias for Oxlint. `pnpm fmt` and `pnpm fmt:check` expose Oxfmt and Ruff formatting.

## Live checks

Automated checks do not prove live ComfyUI behavior. After installing the built
package, verify extension registration, ControlPanel opening and styles, saved
settings, Manager data replacement, and a browser reload after a watch rebuild.
Manager operations should be checked in a disposable installation when needed.
