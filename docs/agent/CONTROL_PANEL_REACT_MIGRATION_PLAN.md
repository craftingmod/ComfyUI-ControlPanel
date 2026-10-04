# ControlPanel React Migration Plan

## Boundaries

- Keep Bun as the frontend build and test tool. Do not restore Vite or change `old/`.
- Keep ComfyUI registration and the existing `controlPanel.open` entry point in `frontend/src/index.ts`.
- Keep API calls, metadata repair, job execution, polling, and toast behavior in the controller/services. React owns all rendered Panel and modal DOM.
- Use one controller-owned view snapshot for operation log, Manager cache availability, restart notice, and update-job output; React subscribes to it. React owns dialog visibility, form inputs, selected snapshot, environment response, focus, and scrolling.
- Keep one React root alive across Panel close/reopen. Closing detaches the Panel, closes dialogs, and stops status polling; reopening reattaches it and refreshes Manager status. Preserve log and Git install form values.
- If a job-start request is still pending when the Panel closes, leave the server job alone but do not start a browser poll when its response arrives.
- Give Snapshot List and Environment requests an opening-generation token. Ignore late results after that dialog or the Panel has closed, and ignore earlier requests after a later opening starts.
- Preserve existing job behavior: poll `UPDATE_STATUS` every 1.5 seconds, stop on terminal state, show terminal toast, replace the log with job output, show restart/dependency-sync notices, and avoid duplicate dependency-sync toasts. Closing does not resume an existing job poll on reopen.

## Steps and status

1. **Inspect contracts and dependencies — complete.** Read the current DOM implementation, entry point, API boundary, CSS tokens, tests, local agent rules, and React/UI skills. Confirm the worktree before editing.
2. **Write this plan — complete.** Use it as the implementation and review checklist.
3. **Move the Panel and dialogs to React — complete.** Put reusable dialog and Panel sections under `frontend/src/components/`, compose them from a page in `frontend/src/pages/`, retain controller/service ownership of operations, and expose view data through one subscribable snapshot.
4. **Move Panel styling to CSS Modules — complete.** Preserve current sizing and responsive layout, put `data-template-theme` on the Panel host and each body portal, and use existing spacing/theme tokens.
5. **Add regression coverage — complete.** Verify open/close/reopen state, snapshot restore selection, Git form persistence, modal keyboard focus/escape/restore, stale async modal responses, job status/log rendering, and polling cleanup including a late job-start response. Focused suite passes 6 tests / 35 assertions.
6. **Validate and review — complete.** Independent read-only review approved the implementation. `bun run validate:agent` passes (frontend 64, backend 147); `bun run build` passes and emits `dist/index.js` plus `dist/index.css`; `git diff --check` is clean. The default pytest temp directory was inaccessible on this Windows host, so validation used a fresh workspace-owned `--basetemp`. Live ComfyUI runtime verification was not performed.

## Stop conditions

- Keep generated CSS declarations current before typechecking.
- Do not change server contracts, ComfyUI registration behavior, or operation semantics to simplify the React rewrite.
- Preserve pre-existing worktree changes and do not commit or deploy.
