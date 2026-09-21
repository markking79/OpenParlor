# TASK-CHAR-002 — Character CRUD APIs

## Goal

Expose the accepted character schema through a focused authenticated API. Keep
the existing uncommitted broad data router out of scope; this task gets its own
route module and does not expose provider configuration.

## Acceptance criteria

- Authenticated endpoints list, get, create, update, delete, and clone only
  the current user's characters.
- Input is validated, IDs cannot be path traversal, and unknown/provider
  configuration fields are rejected rather than persisted.
- Avatar values are safe browser-relative paths and no filesystem paths are
  returned or accepted.
- Focused tests cover lifecycle, validation, and cross-user isolation.

## Exact allowlist

- `src/openparlor/persistence.js`
- `src/openparlor/character-router.js` (new)
- `src/server-startup.js`
- `tests/openparlor/character-router.test.js` (new)

Do not edit `src/openparlor/router.js`, public files, package files, or other
`.agent` control files. Do not stage, reset, clean, discard, or modify
unrelated existing work.
