# OpenParlor Handoff

## Current state

TASK-TTS-003 accepted: authenticated server-side voice discovery now powers
the character editor and validates stored character voices. The router supports
injected raw arrays plus the live Kokoro adapter response `{ ok, data: {
voices: [{ id }] } }` without a hard-coded allowlist. Focused tests: 124
passed; changed-source lint passed; live local provider probe found 68 voices.

## Current state

TASK-TTS-002 accepted: server-only TTS factory and Kokoro adapter support
voice listing, synthesis, and health checks with optional authentication,
safe errors, and `/v1` URL normalization. Focused tests: 20 passed; real
local adapter probe found 68 voices, four models, and synthesized WAV audio.

## Current state

TASK-TTS-001 accepted: the existing Kokoro-FastAPI service is running locally
on port 8880. Its verified OpenAI-compatible base URL, models, voice listing,
and WAV synthesis request/response format are recorded in
`.agent/LOCAL_RUNTIME_DISCOVERY.md`. A real local synthesis request succeeded.

## Current state

TASK-MODEL-001 accepted: authenticated `GET /api/openparlor/model-status`
uses the per-user OpenParlor config loader and configured model-provider
abstraction to safely report provider, configured model, endpoint hostname,
discovered model IDs, and availability. The browser now shows this status in a
small sidebar panel without receiving credentials or a configurable provider
URL. Focused tests: 76 passed; changed-source lint passed; test lint has only
the inherited Playwright `expect-expect` warnings. Local llama.cpp
`/v1/models` probe succeeded and advertises the Qwen GGUF model.

## Current state

TASK-CHAR-004 accepted: server-side prompt assembly now derives global
behavior, character system prompt, character scenario, bounded persisted
conversation history, and newest user content without trusting browser
identity or system/assistant messages. Focused tests: 34 passed; changed-file
lint passed with inherited test-plugin warnings only.

## Current state

TASK-CHAR-003 accepted: the browser now supports creating and editing stored
characters, validates required names, displays safe avatar/name data, and lets
the user start a chat with a selected character. Focused UI helpers: 47 passed.

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

TASK-TTS-003 — Character voice assignment.

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
