# TASK-DATA-002 — Persist one-on-one chats

## Goal

## TASK-DATA-002 — Persist one-on-one chats

Requirements:

- create conversation;
- append messages;
- load conversation;
- list recent conversations;
- rename conversation;
- delete/archive conversation;
- preserve timestamps;
- crash-safe writes.

Acceptance:

- restart server;
- reload browser;
- previous chat remains.

## Allowed files

- `src/openparlor/`
- `public/openparlor/`
- `tests/openparlor/`
- `src/server-startup.js` (only when mounting an OpenParlor route)
- `.agent/local-runtime-inventory.md` (only for local-service discovery)
- `.agent/handoff.md`
Do not modify package files, inherited SillyTavern UI, unrelated files, or any GitHub workflow. Never commit or push.
