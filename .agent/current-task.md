# TASK-CHAR-001 — Character schema

## Goal

Audit the accepted persistence character entity against the execution plan and
make the smallest compatible schema correction needed before a character API
or the conversation-list UI can depend on it. The existing uncommitted broad
data router is explicitly out of scope.

## Acceptance criteria

- A character has the plan's minimum identity, persona, prompt, example,
  tagging, avatar, TTS, ownership, and timestamp fields.
- Existing stored character records remain readable through normalization or
  compatible defaults.
- Character writes preserve immutable identity/ownership/creation fields and
  continue to use the existing crash-safe persistence boundary.
- Focused persistence tests cover schema defaults and update invariants.

## Exact allowlist

- `src/openparlor/persistence.js`
- `tests/openparlor/persistence.test.js`

Do not edit `src/openparlor/router.js`, public files, package files, or other
`.agent` control files. Do not stage, reset, clean, discard, or modify
unrelated existing work.
