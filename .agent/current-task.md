# TASK-CHAR-003 — Character UI

## Goal

Complete the browser character-management experience using the accepted
authenticated character API. Extend the real character list introduced by the
conversation UI; do not use the uncommitted broad data router.

## Acceptance criteria

- List real characters with avatar/name and support create, edit, select, and
  start chat using the authenticated character/conversation APIs.
- Forms validate required character name locally and surface safe API errors.
- Character content never controls provider configuration or filesystem paths.
- Extend focused browser-independent UI tests for pure form/normalization
  helpers; preserve the existing authenticated browser-test deferral.

## Exact allowlist

- `public/openparlor/index.html`
- `public/openparlor/openparlor.js`
- `public/openparlor/openparlor.css`
- `tests/openparlor/openparlor-ui.test.js`

Do not edit OpenParlor server routes, `src/openparlor/router.js`, package files, or other
`.agent` control files. Do not stage, reset, clean, discard, or modify
unrelated existing work.
