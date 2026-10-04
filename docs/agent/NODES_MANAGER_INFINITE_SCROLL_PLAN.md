# Nodes Manager Extensions infinite scrolling

## Ownership and scope

- Primary agent: investigate current contracts, write this plan, orchestrate Luna Max, review changes, run validation, record evidence.
- `gpt-6-luna` at `max`: all runtime implementation, styles, test and manual-testing documentation edits, including review fixes.
- Preserve existing untracked plans under `docs/agent/`. No commits, deployment, real Manager mutations, backend/API changes, or new dependencies.

## Current contract

The controller already loads the complete local catalog and installed data. `NodesManagerPage` filters/sorts it, then slices 48 cards per page. `react-virtuoso` is already installed. Cards vary in height when installed details, version failures, Flagged reasons, or task results appear. Catalog/version/task ownership remains in `nodesManagerController`; selected versions stay above virtualized card mounts.

## Implementation sequence

1. Replace pagination with a bounded-height virtualized continuous Extensions viewport. Keep responsive multi-column cards and all existing controls/statuses. Prefer `Virtuoso` over responsive rows of cards, since it measures variable row heights; use a small reusable component in `frontend/src/components/` if needed. Derive responsive columns from the actual viewport rather than window width. Do not use uniform-height Grid assumptions for variable-height cards or clip task/error content.
2. Use the already-loaded filtered dataset as the source. Either expose the whole dataset to virtualization, or append local 48-card batches through `endReached` if warranted; do not introduce fake network loading or redundant fetches. The user-facing behavior is continuous scrolling to the final result without Previous/Next controls.
3. Stable pack keys, stable override components outside render, positive measured item heights, no outer measured-item margins, one scroll owner, constrained flex height with `min-height: 0`. Remove conflicting content-visibility/intrinsic placeholders if measurement requires it. Preserve native labels, focus visibility, safe links, theme inheritance, CSS Modules, spacing tokens, loading/error/empty states.
4. Reset scroll on committed search/filter/sort changes (including deferred search timing). Keep selected versions, controller task status, and loaded version options across virtualization unmounts and row regrouping. Ordinary operation/version snapshot updates must not reset scroll. Account for resizing and catalog shrink/refresh.
5. Replace pagination regression tests with meaningful continuous-list coverage: beyond first 48, search/filter/sort reset, virtualized rendering bounds, version/operation persistence, empty/error behavior. Happy DOM lacks layout; use documented Virtuoso mock contexts for component checks, and report actual browser scrolling separately. Update `docs/TESTING.md` with first/middle/final results, resize and variable-height cards.
6. Generate CSS declarations before checks. Primary reviews diff and delegates fixes to Luna. Run `bun run validate:agent` once after implementation, `bun run build`, and `git diff --check`; fix introduced failures. Report exact environment blockers without altering unrelated runtime or adding task-specific caches/temp directories.

## References consulted

- Local `react-virtuoso`, `vercel-react-best-practices`, `web-design-guidelines` and `ponytail` skills.
- Official endless scrolling: https://virtuoso.dev/react-virtuoso/virtuoso/endless-scrolling/
- Current `NodesManagerPage`, card styles, service/controller and existing UI tests.

## Stop rules and completion

No mutation contract changes. Do not broaden into Manager queue work, catalog server pagination, full UI redesign, or unrelated fixes. Primary must review actual diff and validation evidence. Real ComfyUI/scroll/keyboard behavior is unverified unless observed; automated mock layout is not live browser proof.

## Progress and evidence

- Investigation and plan: complete.
- Implementation: complete. `NodesManagerPage` now passes the full filtered catalog to `Virtuoso` in responsive rows; a `ResizeObserver` measures the actual scroller width, and Virtuoso measures variable row heights. The Extensions scroller has a named region, `tabIndex=0`, and a visible focus outline. Search resets after `useDeferredValue` commits, while filter and sort changes reset immediately; controller snapshots are excluded from reset dependencies. Selected versions stay in page state and operations/version options stay in the controller snapshot. The card's intrinsic placeholder sizing was removed so measurements include loaded versions, Flagged reasons, and task results.
- Regression coverage: the existing pagination test is replaced with a `VirtuosoMockContext` scenario covering more than 48 results, bounded mounted cards, the former final page boundary, scroll preservation through a version snapshot, selection persistence after virtual unmount, filter/sort/search resets, and the empty search result. `docs/TESTING.md` now describes first/middle/final scrolling, responsive resize, variable-height cards, and keyboard navigation.
- CSS module declarations generated. Focused Nodes Manager UI test passed (5 tests, 56 assertions); frontend TypeScript checks and `git diff --check` passed.
- Primary review: complete. Reviewed actual page, styles, regression tests and manual documentation. Delegated box-sizing, shared token placement and test-data/mock-layout corrections to Luna Max. Scroll reset uses a cancellable animation frame after committed query changes; ordinary snapshots do not reset it. No controller/backend or dependency changes.
- Primary validation: `bun run validate:agent` passed typecheck, TypeScript/CSS/Python lint, formatting, and all 85 frontend tests. Initial backend execution was blocked by the missing configured `.ci-cache/tmp`; preparing that standard ignored directory let tests run. Backend retry: 157 passed, 1 failed in the existing `test_dynamic_versioning_preserves_named_tags_and_prereleases` because `uvx` exited 2. Direct reproduction captured `Failed to initialize cache at F:\\Scoop\\persist\\uv\\cache`, access denied opening `sdists-v9\\.git` (os error 5). Existing Scoop cache/shim environment is outside this feature; no unrelated source changes were made to bypass it.
- `bun run build` and `git diff --check`: passed.
- Live ComfyUI/browser verification: not run. Responsive row changes, actual variable-height measurement, browser keyboard scrolling, and final-result scrolling remain unverified in a live browser.
