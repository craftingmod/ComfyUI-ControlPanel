## frontend/test

## Context

`bun` + `DOM (happyDOM)` Context

## Purpose

Contains frontend unit tests executed by Bun's test runner. Happy DOM is
preloaded by the frontend test commands, so tests can exercise browser-facing
source with DOM APIs while still using `bun:test` mocks, spies, and assertions.
This folder also tests Bun-side frontend tooling and related repository scripts.
