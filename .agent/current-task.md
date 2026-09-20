# TASK-DATA-001 — Define OpenParlor persistence boundary

## Goal

## TASK-DATA-001 — Define OpenParlor persistence boundary

Choose the simplest persistence that fits the existing app.

Prefer reusing safe existing SillyTavern storage conventions where doing so reduces risk, while placing OpenParlor-specific data behind OpenParlor APIs.

Do not expose filesystem paths to the browser.

Define entities:

- Character
- Conversation
- ConversationParticipant
- Message
- Memory
- UserOpenParlorSettings

Document IDs, timestamps, ownership, and migration strategy.

## Allowed files

- `src/openparlor/`
- `public/openparlor/`
- `tests/openparlor/`
- `src/server-startup.js` (only when mounting an OpenParlor route)
- `.agent/local-runtime-inventory.md` (only for local-service discovery)
- `.agent/handoff.md`
Do not modify package files, inherited SillyTavern UI, unrelated files, or any GitHub workflow. Never commit or push.
