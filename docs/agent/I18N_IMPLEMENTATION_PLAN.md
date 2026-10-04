# ControlPanel English/Korean i18n implementation

## Goal and verified contract

Support English and Korean throughout the shipped ControlPanel UI using the official custom-node layout: root `locales/en/` and `locales/ko/`, with `main.json`, `settings.json`, and `commands.json` where applicable.

Official reference: https://docs.comfy.org/custom-nodes/i18n (checked 2026-10-05). Settings translation keys replace dots in IDs with underscores. `main.json.settingsCategories` provides category translations. The custom frontend localization section is still unfinished, so a minimal React/native-DOM adapter is needed. Use these same dictionaries rather than maintaining a second source of translations.

The installed ComfyUI frontend contract was checked at `V:/ComfyUI/portable_260711/.venv/Lib/site-packages/comfyui_frontend_package/static/assets/settingStore-DDHzGrHr.js`: `ComfySettingsDialog.dispatchChange(id, value, oldValue)` dispatches `<id>.change`, and setting updates call it with `Comfy.Locale`. The adapter subscribes to `app.ui.settings` for `Comfy.Locale.change`; React receives the host target and locale reader through dependency injection, so UI/service tests do not import the host-only `scripts/app.js`. The same installed bundle's source map confirms command-label lookup with normalized command IDs and support for function-valued command labels. Action-bar labels and tooltips accept static strings, so they use the locale at registration and refresh after a browser reload.

## Owners

- Primary agent: investigation, this executable plan, final review and reporting.
- Luna Max implementation agent: runtime adapter, dictionary authoring, all string replacements, packaging changes, tests, fixes and plan completion notes.

## Sequence

1. Verify `Comfy.Locale` access and change notification against installed frontend types and current official/installed ComfyUI sources. Use the host language setting without registering another language selector or replacing host callbacks. Document the supported notification mechanism. Fall back to English for unsupported/missing locales and missing translations.
2. Add English/Korean dictionaries in root `locales`. Namespace custom UI keys to avoid collisions with host/other extensions. Use `,`, never `·`, in Korean text. Preserve placeholders exactly. Keep brands, paths, URLs, IDs and payload enum values stable. No `nodeDefs.json` is needed for unregistered example nodes: the current pack registers no backend nodes.
3. Add a small dependency-free translator and a React subscription hook using the existing external-store pattern. Bundle/import the root dictionaries for custom React UI while letting ComfyUI load the standard files for settings/commands. Translate visible labels, buttons, headings, tooltips, placeholders, ARIA labels, confirmations, empty/loading/error states, toasts, and locally authored operation messages across components/pages/controllers/services and native DOM entry points.
4. Existing backend/process logs, external catalog descriptions, and remote error details remain verbatim diagnostic data. Translate local framing and fallback messages. Already emitted historical log lines need not be rewritten on language changes; open React surfaces must update and newly emitted messages must use the selected language. Inspect initial state text and host-owned static command/action-bar metadata for correct initial localization and change behavior supported by ComfyUI.
5. Add `locales` to distribution inclusion rules and verify release/development packaging paths. Do not deploy or restart ComfyUI as part of implementation. Update concise maintainer/user documentation for language selection, fallback, and adding translation keys.
6. Add focused checks for dictionary key/placeholder parity, Korean punctuation, translation fallback/interpolation, locale change behavior and subscription cleanup. Run `bun run validate:agent` and `bun run build`, fixing introduced failures. Verify archive inclusion without unrelated release/version changes. Document environment blockers precisely and distinguish automated checks from live ComfyUI/browser validation.

## Preservation and stop rules

- Existing dirty change in `frontend/src/components/NodesManagerCard.tsx` adds the `RefreshCcw` icon to Update. Preserve it exactly while translating adjacent text.
- Preserve Controller/store/history ownership, network routes, workflow identifiers, settings IDs, command IDs, operation payload values and existing UI interactions.
- Do not add an i18n dependency or change unrelated CSS/layout, backend schemas, or node registrations.
- If the host has no supported custom-frontend translation API, use a small verified locale-setting bridge; do not import private Vue stores or monkey-patch setting methods.
- Report unsupported or unavailable live validation as unverified rather than inferring success from unit/build checks.

## Completion record

- [x] Host locale contract verified and documented
- [x] Standard English/Korean dictionaries added
- [x] Runtime/frontend strings replaced by Luna Max
- [x] Packaging and documentation updated
- [x] Focused checks, required validation and build recorded
- [x] Primary review and remaining live-validation limits recorded

## Implementation and validation record

- Focused i18n checks: 5 tests passed, including locale event cleanup/resubscription, React rerender on `Comfy.Locale.change`, main/settings/commands key parity, placeholder parity, fallback/interpolation and Korean punctuation.
- Related UI checks: 17 tests passed with 421 assertions. Full frontend suite: 91 tests passed with 639 assertions.
- `bun run validate:agent`: typecheck, lint, and formatting passed; frontend passed (91 tests, 639 assertions). Backend reported 157 passed and one failure in `tests/python/test_project_version.py::test_dynamic_versioning_preserves_named_tags_and_prereleases`, because its subprocess `uvx uv-dynamic-versioning` could not initialize the default `F:/Scoop/persist/uv/cache` (access denied opening `sdists-v9/.git`, Windows OS error 5). Rerunning only that test with the repository-sanctioned `.ci-cache/uv` and `.ci-cache/tmp` paths passed (1 test).
- `bun run build`: passed, including production frontend bundle generation.
- `bun run build:custom-node`: passed with the repository-sanctioned existing `.ci-cache/uv` and `.ci-cache/uv-tools` paths. Built `build/ComfyUI-ControlPanel-1.2.5.post13.dev0+9e57f18.zip` (32 files); archive inspection confirmed all six `locales/{en,ko}/{main,settings,commands}.json` entries. The build rewrote ignored `backend/_version.py`; its pre-build value `1.2.5.post3.dev0+53518ab` was restored after verification. Static checks also confirmed `.comfyignore`, `pyproject.toml`, and `package.json` include rules.
- `bun run fmt` made line-wrapping-only normalization in four existing CSS files; no CSS values or layout behavior changed.
- No ComfyUI deployment or restart was performed. Live setting selection, native action-bar refresh, browser behavior, and ComfyUI archive installation remain unverified. Adding translation files to a running ComfyUI installation requires restart for host discovery, then browser reload.

## Primary review

- Implementation was delegated to two Luna Max agents with separate ownership of React UI and translation infrastructure/controllers. The primary agent reviewed their combined changes and ran `git diff --check` successfully.
- Verified the installed host's `Comfy.Locale.change` event in `V:/ComfyUI/portable_260711/.venv/Lib/site-packages/comfyui_frontend_package/static/assets/settingStore-DDHzGrHr.js`; its source map also confirms command translation lookup by normalized command ID. Root locale discovery and process caching were checked in the installed `ComfyUI/app/custom_node_manager.py`.
- Reviewed standard settings/command keys, locale subscription cleanup/resubscription, provider isolation, interpolation, runtime message keys versus raw diagnostics, unchanged request routes/payload values, and preservation of the existing `RefreshCcw` icon change. No remaining actionable issues were identified in these checks.
- Automated React checks do not establish live ComfyUI rendering or native registration refresh. Those manual checks remain unverified as stated above.
