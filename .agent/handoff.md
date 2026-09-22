# OpenParlor Handoff

## Current state

TASK-MEM-002 accepted and pushed (`02e5c5cd2`): completed character turns now
launch server-side, non-blocking durable-memory extraction after the response
has finished. Candidates require bounded JSON, reject trivial dialogue and
instructions, deduplicate against active memories visible to the character,
and retain conversation/message provenance plus only the characters present.
Extraction errors are contained and never change the delivered chat result.
Focused validation: 52 Node tests passed; changed-source lint passed; test lint
has only inherited warning-level Playwright rules. Local llama.cpp health probe
passed. No browser or provider-configuration surface was added.

## Current state

TASK-MEM-001 accepted and pushed (`66e0106cd`): the persistence boundary now
stores character-centric memories with type, bounded importance/confidence,
active/supersession state, provenance, and character knowledge visibility.
Legacy records normalize without a migration write and remain visible to their
original character; list operations are owner-isolated and deterministic.
Focused persistence tests: 35 passed; changed source/test lint and diff check
passed. No browser or provider surface was added.

## Current state

TASK-AUDIO-002 accepted and pushed (`64be0cea9`): development-only local
voice-turn timing now measures recording end→STT completion, send→first model
token, first model token→completed stream, completed stream→TTS audio ready,
and the full recorded turn when those boundaries exist. Console diagnostics
contain duration labels only—never transcript, generated text, voice, endpoint,
configuration, or credentials—and incomplete/cancelled/error/chat-switch paths
clear timing safely. Focused UI helpers: 145 passed; changed-source lint passed;
test lint contains only inherited warning-level Playwright rules. Local llama.cpp
and Kokoro health probes passed. Authenticated browser acceptance remains
deferred because `ST_AUTH_STORAGE_STATE` is not configured.

## Current state

TASK-AUDIO-001 accepted and pushed (`9699a581a`): the conversation header now
has an accessible per-conversation Voice control, off by default and stored
locally by conversation ID. Voice mode sends a successful transcript through
the existing CSRF-protected chat flow once and uses the existing completion-only
server-proxied playback only when the character has an assigned voice. Disabled
mode keeps the existing transcript-for-review behavior; existing playback
guards handle failed streams and conversation changes. Focused UI helpers: 132
passed; changed-source lint passed; test lint contains only inherited
warning-level Playwright rules. Authenticated browser acceptance remains
deferred because `ST_AUTH_STORAGE_STATE` is not configured.

## Current state

TASK-STT-005 accepted without a production change: a real local WAV passed
through the authenticated OpenParlor STT router using only the default user's
server-side config, produced “OpenParler Transcription Verification,” and that
text then reached local llama.cpp through the authenticated chat router. The
completed NDJSON stream contained 1,259 generated characters and a `done`
record. UI helper coverage confirms successful transcription returns text for
the composer and does not itself call the send flow. Focused regression: 173
Node tests passed; changed-source lint passed; test lint had only the inherited
warning-level Playwright rules. Browser verification remains deferred because
`ST_AUTH_STORAGE_STATE` is not configured. No implementation file changed, so
there is intentionally no task commit.

## Current state

TASK-STT-004 accepted: authenticated OpenParlor multipart transcription now
accepts one bounded recorded-audio upload under global CSRF protection, derives
the faster-whisper adapter configuration only from the authenticated user's
server-side config, and returns only safe transcript text/language or safe
errors. The composer now transcribes a stopped Blob through OpenParlor, shows
busy/safe failure state, inserts successful text for review without sending,
and always releases the retained recording. Focused validation: 123 Node
tests, 9 config tests, task JS lint with zero errors, and real local provider
health all passed. Authenticated browser acceptance is deferred because
`ST_AUTH_STORAGE_STATE` is not configured; Playwright Chromium is installed.

## Current state

TASK-STT-003 accepted: the browser composer now has local-only MediaRecorder
controls with MIME negotiation, record/stop/cancel state, permission and
unavailable feedback, bounded in-memory chunks, duration/size cutoffs, and
track cleanup. It deliberately retains a ready Blob only; it does not upload,
transcribe, auto-send, or expose provider configuration. Focused helpers: 117
passed in 213 ms; changed-source lint passed; test lint has only inherited
warning-level Playwright rules. Authenticated browser acceptance is deferred:
no `ST_AUTH_STORAGE_STATE` is configured locally.

## Current state

TASK-STT-002 accepted and pushed (`41b36ef86`): a server-only local
`faster-whisper` provider now invokes the installed managed Python engine with
argument-array spawning, a bounded stdin JSON protocol, offline-only cached
model loading, input/time limits, and safe error mapping. Focused tests: 26
passed; changed-source lint passed; test lint has only inherited
`playwright/expect-expect` warnings. A real Node adapter health check and WAV
transcription through cached `large-v3-turbo` succeeded.

## Current state

TASK-TTS-006 accepted and pushed (`9801a5319`): authenticated server-side
speech cleanup now strips complete model reasoning blocks, fenced code, image
URLs, and inline-code markers only immediately before synthesis. Browser
message content is unchanged; cleanup-only input returns a safe 400 without
calling the provider. Focused tests: 71 passed; changed-file lint passed.

## Current state

TASK-TTS-005 accepted and pushed (`568cf5949`): OpenParlor now has a
per-conversation, reload-safe Auto-speak control. Only successful, completed
new assistant replies are synthesized with the assigned character voice.
Explicit Stop, disabling Auto-speak, and selecting a conversation stop or
supersede playback; concurrent synthesis cannot race into overlapping audio.
Focused UI helpers: 93 passed; changed-source lint passed; test lint emits
only inherited warning-level Playwright rules.

## Current state

TASK-TTS-004 accepted: OpenParlor now proxies authenticated server-side audio
synthesis and renders accessible assistant-message play, stop, and replay
controls. Browser playback uses a Blob URL and enforces one active audio item,
releasing resources on stop, replay, natural completion, rejected play, and
chat switch. Focused tests: 109 passed; changed-source lint passed; a live
Kokoro proxy request returned 29,612 audio bytes.

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

TASK-TTS-004 — Play assistant messages.

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
