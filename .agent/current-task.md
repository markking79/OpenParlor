# TASK-CHAT-002 — Conversation history sent correctly

## Goal

## TASK-CHAT-002 — Conversation history sent correctly

The current browser/API must send relevant conversation history, not only the newest line.

Implement a server-controlled message-building layer.

Do not yet mix memory retrieval into this task.

Acceptance:

- multi-turn context works;
- system/user/assistant roles remain valid;
- malformed client roles are rejected/sanitized;
- token growth is bounded.

## Allowed files

- `src/openparlor/`
- `public/openparlor/`
- `tests/openparlor/`
- `src/server-startup.js` (only when mounting an OpenParlor route)
- `.agent/local-runtime-inventory.md` (only for local-service discovery)
- `.agent/handoff.md`
Do not modify package files, inherited SillyTavern UI, unrelated files, or any GitHub workflow. Never commit or push.
