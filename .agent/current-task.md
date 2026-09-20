# TASK-DATA-002 — Persist one-on-one chats

## Goal

Expose an authenticated, server-owned one-on-one conversation API and connect
chat generation persistence to it. Do not accept the preserved overbroad data
router; character/memory/settings APIs belong to later tasks.

## Acceptance criteria

- Authenticated API supports create, list recent, load, rename, and archive
  or delete conversations, without filesystem path exposure or cross-user
  access.
- Conversations have one character participant and append valid user and
  assistant messages with timestamps; chat requests referencing a conversation
  persist exactly those messages.
- Chat never trusts browser participant IDs or roles for server persistence;
  stream success persists the completed assistant content once, while aborts
  and errors never fabricate a successful assistant record.
- Focused tests cover route ownership, lifecycle, restart/read round trip,
  chat persistence, and stream/error behavior.

## Exact allowlist for worker

- `src/openparlor/persistence.js`
- `src/openparlor/chat-router.js`
- `src/openparlor/conversation-router.js` (new)
- `src/server-startup.js`
- `tests/openparlor/persistence.test.js`
- `tests/openparlor/chat-router.test.js`
- `tests/openparlor/conversation-router.test.js` (new)

Do not edit `src/openparlor/router.js`, public files, package files, or any
`.agent` control files. Do not commit, push, stage, reset, clean, or discard
existing work.
