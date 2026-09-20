# TASK-DATA-001 — Define OpenParlor persistence boundary

## Goal

Audit and complete the preserved filesystem persistence boundary for the six
OpenParlor entities. Keep data strictly within the authenticated user's
`directories.root/openparlor` area and provide a small, server-only API for
later route/UI tasks.

## Acceptance criteria

- Character, Conversation, ConversationParticipant, Message, Memory, and
  UserOpenParlorSettings have documented IDs, timestamps, ownership, and a
  schema-version migration anchor.
- New records and metadata are created beneath the user root; no persistence
  API accepts a browser-supplied filesystem path.
- Entity writes are atomic where a full JSON document is replaced. Message
  storage tolerates a trailing corrupt/incomplete JSONL record after a crash.
- Reading a missing collection returns an empty result; malformed persisted
  JSON does not crash a list operation.
- Focused Node tests verify ownership filtering, round trips, recency order,
  and corrupted-tail recovery.

## Exact allowlist for worker

- `src/openparlor/persistence.js`
- `tests/openparlor/persistence.test.js` (new)

Do not edit routes, startup wiring, chat code, public files, package files,
or any `.agent` control files. Do not commit, push, stage, reset, clean, or
discard existing work.
