# Registry cache

Registry state lives in `<ComfyUI user>/__controlpanel/manager-cache/registry.db`,
shared across repository channels. The Manager-facing `/nodes` JSON cache keeps its
existing format; startup deployment reads SQLite without network requests. An old
`registry-node-list.json` remains an offline fallback until SQLite bootstrap succeeds.

The implementation keeps the existing `manager_api.py` refresh/deploy facade and
refresh lock. `registry_cache.py` owns SQLite and the four independent sync stages;
`registry_installed.py` reads local Registry identities without importing Manager.

- `nodes`: catalog payload keyed by `node_id`. Full `/nodes` bootstrap with 100
  entries per request, followed by incremental queries using the largest observed
  node `created_at` with overlap. Catalog `latest_version` is a snapshot.
- `installed_node_versions`: three version objects (`latest_active`, `latest_flagged`,
  `newest_observed`), explicit seed/reconciliation timestamps and reconciliation flag.
  Full history is parsed only for seed/reconciliation and is never stored.
- `sync_state`: schema/environment, last full catalog sync time, catalog cursor, global activity
  anchor ID/time, bounded recent seen IDs and refresh times. Publisher data stays in
  its catalog payload; a separate publisher table is unnecessary.

Bootstrap captures global HEAD before installed-node seeds and catches up afterward.
Hourly sync refreshes installed Active versions using repeated `node_id` batch
queries, reads `/versions?pageSize=100` until the previous anchor plus one overlap
page, and deduplicates IDs. If the anchor disappears, its creation time bounds the
scan. Feed order is checked before the anchor can advance. The feed detects creation;
existing row status changes are handled through installed-node reconciliation.
Only nodes marked for reconciliation have their filtered history requested.

New installations seed immediately on the next cache refresh, including inside the
hourly TTL. Empty Flagged results are represented by a null object and a completed
seed timestamp. Local scanning includes all configured custom-node roots, disabled
directories, Registry archive tracking and Git Registry identities/repository matches.
Local IDs match catalog IDs without case sensitivity; requests and summaries retain
the Registry's original spelling because `/nodes` filters are case-sensitive.
Manager deployment overlays installed `latest_active` onto the catalog snapshot.
In Settings > ControlPanel > Manager, `Allow flagged version as latest` (off by
default) selects cached `latest_flagged` when its SemVer is newer than `latest_active`,
or when no Active version exists. The exported version retains its Flagged status;
SQLite data and stored summaries stay unchanged. This applies to startup deployment
and cache refresh/rebuild. Changing the toggle redeploys the cached data immediately
when Replace Manager Repository Data is enabled.
Full-history version selectors may continue using `/nodes/<id>/versions` on demand.

ComfyUI version/form-factor changes, 30 days since the last catalog full sync, or
manual rebuild perform a full `/nodes` reconciliation inside the existing SQLite
transaction. Global anchors and healthy installed-version summaries are preserved;
these events do not reseed version history. ComfyUI version/form-factor changes
refresh the Active batch under the new compatibility conditions immediately,
preserving completed version-history seeds. Schema/cache-format incompatibility,
SQLite integrity failure or unrecoverable sync/anchor state alone trigger a hard
rebuild in a temporary SQLite DB, replaced only after all stages succeed.
Incremental/full-catalog stages commit together or roll back together.
API failures preserve the committed catalog, summaries and anchor for retry/restart.
Manual rebuild no longer deletes the existing source directory before fetching.

Contract references: [deployed OpenAPI](https://api.comfy.org/openapi),
[nodes](https://docs.comfy.org/registry/api-reference/registry/retrieves-a-list-of-nodes),
[version activity](https://docs.comfy.org/registry/api-reference/registry/list-all-node-versions-given-some-filters),
[node history](https://docs.comfy.org/registry/api-reference/registry/list-all-versions-of-a-node).

Regression checks are in `tests/backend/test_registry_cache.py`,
`tests/backend/test_registry_installed.py` and the Registry facade/deployment cases in
`tests/backend/test_manager_api.py`. Run the existing `pnpm test:backend` command.
If the standalone development environment lacks ComfyUI's `aiohttp`, use
`uv run --with aiohttp pytest tests/python tests/backend -q` for the same suites
without adding a runtime dependency to this node pack.
