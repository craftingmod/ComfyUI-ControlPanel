# UI spacing and component reuse

## Scope and ownership

- Keep existing uncommitted Nodes Manager behavior and Controller ownership.
- `styles/globals.css` owns the eight spacing tokens: 2xs, xs, sm, 3sm, md, lg, xl, 2xl.
- `components/ui/` owns reusable Button and Badge presentation, native attributes, refs, focus, disabled states, and variants.
- Pages and feature components own layout only; remove duplicate button styling and obsolete shared button classes.

## Sequence

1. Replace pixel-named spacing with scale values: 5 -> 4, 6 -> 8, 9 -> 8, 10 -> 8, 14 -> 16, 20 -> 24. Reserve 48px above log text for its overlaid controls.
2. Move existing UI drafts into components/ui, consolidate button sizes and variants, and use them across dialogs, cards, manager, and sidebar.
3. Reuse Badge for card source/update labels and remove unused legacy presentation rules.
4. Generate CSS declarations, run validate:agent and build, review the final diff.

## Stop rules and verification

- Preserve operation callbacks, confirmations, form state, virtualization, and native DOM integration.
- Do not change fonts, icon geometry, or breakpoints merely to fit spacing tokens.
- Fix introduced check failures; report environment blockers separately from live ComfyUI visual verification.

## Status

- Implementation complete. Pixel-named spacing and duplicate feature button rules removed.
- Typecheck, lint, formatting, 86 frontend tests, and production build passed.
- validate:agent backend result: 157 passed, one versioning test blocked because uvx cannot initialize F:/Scoop/persist/uv/cache (access denied). A focused reproduction confirms the cache failure.
- Live ComfyUI visual verification remains unrun.
