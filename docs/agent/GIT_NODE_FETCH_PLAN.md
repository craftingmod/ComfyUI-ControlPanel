# Individual Git node Fetch

- Backend: add a scoped POST job route. Resolve the installed folder key only among discovered custom-node Git repositories; reject missing, ambiguous, or outside-root targets. Reuse the existing Git update job and `git pull --ff-only` behavior.
- Service and Controller: submit Git updates to the scoped route, poll the existing job endpoint, and publish progress/results into the current operation store. Refresh installed metadata after completion. Keep Registry queue handling unchanged.
- View: Git cards always show HardDriveDownload + Fetch, ignore Registry latest-version/Flagged data, and never open Registry version choices.
- Verify: mocked backend target isolation and Git command behavior; mocked Controller route/poll/error behavior; UI label and action checks; `bun run validate:agent`. Do not mutate real installed repositories for validation.

Implementation is complete. Per the user's follow-up, tests and validation are deferred to the user; no real Git update was executed.
