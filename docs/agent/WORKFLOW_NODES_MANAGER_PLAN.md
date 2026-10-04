# Nodes Manager workflow categories

## Objective and ownership

Add two sidebar categories to ControlPanel Nodes Manager: `Workflow의 모든 커스텀 노드` and `Workflow의 미설치 노드` (English: `Workflow custom nodes`, `Workflow missing nodes`). They list extension packs required by the currently open workflow, including nested subgraphs. Existing catalog categories, installation/version selection, task reconciliation, and history ownership remain intact.

The primary agent owns this plan, integration review, and reporting. A `gpt-6-luna` subagent with `max` reasoning owns runtime implementation, translations, and tests. A second Luna Max agent reviews the resulting diff after implementation. Do not install/uninstall/enable/disable packages or restart ComfyUI for verification.

## Verified contracts

- Existing `cnrMetadata.ts` exposes `resolveNodeMetadata` / `createMetadataCache`; `graphWalker.ts` recursively walks runtime subgraphs without mutating nodes.
- Read `app.rootGraph` first, falling back to `app.graph` for older/test hosts. The installed frontend types declare `rootGraph`; the canvas may display only a nested graph.
- Local Manager responds HTTP 200 to `/v2/customnode/getmappings?mode=local`; `/customnode/getmappings?mode=local` returns 404. Use v2 first, legacy fallback only on HTTP 404. Manager's official `glob/manager_server.py` documents the legacy equivalent.
- Mapping entries are `[nodeTypeNames, metadata]`; keys can be canonical Registry IDs or repository URLs. Metadata can contain `nodename_pattern` and `preemptions`. GitHub URLs require joining to catalog `repository` or installed `aux_id`; do not compare URLs directly with Registry IDs or infer an ID solely from a repo basename.
- Official ComfyUI hooks documentation: https://docs.comfy.org/custom-nodes/js/javascript_hooks . No new hook or prototype patch is required: inspect the current root workflow on opening and refreshing this modal. The modal prevents editing the graph behind it.

## Implementation sequence

1. Add a bounded, read-only workflow resolver in the existing service layer (a focused `nodesManagerWorkflow.ts` helper is appropriate). Reuse `collectGraphNodes`, metadata resolver, installed normalization, and repository normalization rather than inventing a second identity model. Expose a narrow existing repository helper if needed.
2. Resolve each runtime node in this order:
   - Recognized runtime `python_module` and installed package identity (authoritative for loaded nodes).
   - Saved `properties.cnr_id` / `properties.aux_id` for placeholders or missing runtime metadata.
   - Manager mapping exact node type, respecting explicit preemptions/core ownership; then valid `nodename_pattern` patterns.
     Exclude `comfy-core`, known core modules/mappings, frontend-only nodes such as Note/Reroute, and subgraph wrapper nodes while walking their contents. Do not use display titles as type names. Catch malformed mapping entries and invalid regexes. Do not arbitrarily choose one extension when multiple distinct owners match.
3. Resolve owner identities to existing `ManagedPack` descriptors by canonical ID or normalized repository. Support Registry owners absent from the local catalog with a workflow-only descriptor if exact identity is known; missing catalog metadata must not turn an unrelated extension into an install target. For non-Registry map-only repositories, show a workflow-only read-only descriptor with title/repository and unavailable install actions; do not add a new Git install pipeline.
4. Group resolved nodes by extension, deduplicating packs. Keep unresolved and ambiguous node types as diagnostic entries with their types and candidate owners where available. These entries must not silently disappear and must not expose guessed install actions. Keep missing runtime node types in diagnostics even when their extension is installed (disabled packs or import failures are not absent packages).
5. The controller owns workflow analysis, mapping requests, state, errors, and async generation guards. Load mappings concurrently with existing catalog/installed reads. Preserve direct metadata identification if mappings fail; show a degraded analysis notice. If installed listing fails, mark availability unknown rather than claiming everything is missing. Closing/reopening and competing refreshes must discard stale results. Recompute pack availability when task completion refreshes installed data.
6. Add two sidebar filters and counts. Workflow custom category includes all resolved custom extension packs required by the root workflow. Workflow missing category includes those confirmed absent from the installed list, with known unavailable-node diagnostics displayed separately and accurately labeled. Disabled installed packs remain installed and keep existing disabled indicators/actions. Use existing search, sorting, card rendering, virtualization, and state for resolved packs. Use stable pack keys and preserve selected versions/task state across filtering. Unresolved diagnostics are visibly available in workflow categories; distinguish unresolved ownership, ambiguous ownership, unavailable node types, and analysis failure from an empty workflow. Count known extensions in category badges and report unresolved node count separately, avoiding mixed units.
7. Add localized English/Korean labels and messages. Use commas instead of middle dots in Korean. Reuse existing UI components, CSS Modules and spacing tokens. No unrelated card layout, lifecycle, catalog caching, or queue rewrite.

## Checks and acceptance

- Focused resolver tests: canonical `cnr_id`, Git `aux_id` normalization, runtime ownership overriding stale saved metadata, mixed ID/URL mapping keys, exact-name and regex-only entries, duplicate/ambiguous owners, preemptions/core, core/frontend exclusions, installed/absent/disabled state, nested root traversal and shared/cyclic graphs, unknown node diagnostics, invalid regex/malformed entries, no graph/property mutation.
- Controller checks: mapping API v2/legacy fallback, failed mapping still preserves metadata results, installed failure does not create false missing packs, graph rescan on reopen/refresh, stale async results rejected, successful installed refresh reconciles workflow category membership.
- UI checks: both categories, extension counts, search/sort reuse, unresolved and unavailable diagnostics, disabled behavior, known missing Registry cards retain existing exact-version install flow, read-only unregistered placeholders do not queue invalid operations, selected versions/task indicators survive category changes.
- Consult `vercel-react-best-practices`, `web-design-guidelines` (including its local `command.md`) and `react-virtuoso` when touching their applicable areas.
- Format only changed source files, run `bun run validate:agent` and `bun run build`, and `git diff --check`. The existing environment has previously blocked the unrelated `uvx uv-dynamic-versioning` tag test; report any recurrence with evidence, do not change unrelated versioning code to hide it.
- Read-only live API probes are allowed. Browser verification may inspect workflow/category behavior without mutations. Keep automated, live read-only API, and actual browser evidence separate.

## Status

- [x] Inspect contracts and write implementation plan.
- [x] Luna Max implementation and focused tests. Resolver/controller/UI coverage passes: 36 focused tests, 148 expectations; frontend typecheck passes.
- [x] Independent Luna Max review and required corrections. The reviewer accepted the explicit Registry/repository alias bridge and confirmed the two-Registry-IDs-to-one-repository ambiguity regression. Final read-only review signed off.
- [x] Required validation/build and final evidence report.
  - `bun run build`, focused tests (36 passed, 148 expectations), frontend typecheck, formatting, and `git diff --check` pass. `bun run validate:agent` passed typecheck, lint, formatting, and 111 frontend tests; backend tests reported 158 passed and one unrelated `uvx uv-dynamic-versioning` failure due to access denied at `F:\Scoop\persist\uv\cache`.
- Read-only browser evidence from the primary: the open workflow with three Reference Loader instances and core nodes shows one deduplicated installed Reference Loader pack, zero missing packs, and no workflow/package mutations.

## Stop conditions

Do not invent ownership for ambiguous or unknown nodes, erase saved properties, mutate the workflow to make identification easier, replace the canonical Controller, or interpret successful enqueue as successful installation. If a source cannot identify an owner, retain a diagnostic and allow other categories/identified extensions to work.
