# OpenParlor Handoff

## Current state

TASK-DATA-003 accepted: the OpenParlor browser UI now loads stored characters
and conversations, creates a one-on-one chat from the selected character,
loads persisted messages, and associates streamed chat requests with the active
conversation. Focused pure-helper tests: 27 passed. Authenticated Playwright
acceptance remains deferred until a developer-local storage-state file exists.

## Current state

TASK-CHAR-002 accepted: authenticated character list/get/create/update/delete/
clone APIs are mounted at `/api/openparlor/characters`. The focused test suite
has 32 passing tests and validates input, safe browser-relative avatars, and
cross-user isolation. The broad uncommitted `src/openparlor/router.js` remains
intentionally excluded.

## Current state

TASK-DATA-002 accepted: authenticated one-on-one conversation lifecycle and
chat persistence are available at `/api/openparlor/conversations`. Focused
tests: 54 passed; changed-source lint passed. The broad pre-existing
`/api/openparlor/data` mount and `router.js` remain intentionally uncommitted.

## Current state

TASK-DATA-001 is accepted. OpenParlor now has a server-only, per-user
filesystem persistence boundary under `<directories.root>/openparlor`.

## Last completed task

TASK-DATA-001 — Define OpenParlor persistence boundary.

## Accepted implementation

- `persistence.js` documents Character, Conversation,
  ConversationParticipant, Message, Memory, and UserOpenParlorSettings with
  UUID IDs, timestamps, ownership, and a schema version anchor.
- Full JSON entity writes use atomic replacement. JSONL reads recover from a
  trailing malformed record after a crash and list operations skip corrupt
  JSON records.
- Update helpers preserve immutable IDs, creation timestamps, and ownership.
  Their update timestamps are monotonic even inside one millisecond.
- Persistence stays under the authenticated user's directory root and has no
  provider/browser configuration surface.

## Verification

- `git diff --check`
- `node --test tests/openparlor/persistence.test.js` — 15 passed
- `npm run lint -- --no-cache src/openparlor/persistence.js` — passed
- `tests/node_modules/.bin/eslint --no-cache tests/openparlor/persistence.test.js` — passed

The broad `tests` lint wrapper remains unsuitable as task evidence: it scans
unrelated pre-existing TASK-004 tests and reports their two comma-dangle
errors. No out-of-scope file was edited to hide those failures.

## Preserved later-task work

`src/openparlor/router.js`, the `src/server-startup.js` router mount, and the
chat persistence edits remain deliberately uncommitted. They pre-implement
parts of later DATA/CHAR/MEM tasks and require separate task-scoped audit;
they were not accepted by TASK-DATA-001.

## Next dependency-safe task

TASK-DATA-002 — audit and complete one-on-one conversation persistence using
the accepted boundary, then integrate only the required authenticated routes
and chat flow.
