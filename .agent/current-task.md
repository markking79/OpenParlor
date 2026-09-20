# TASK-CHAT-003 — Generation cancellation

## Goal

## TASK-CHAT-003 — Generation cancellation

Add Stop Generation.

Requirements:

- browser uses `AbortController`;
- server sees disconnect/abort;
- provider request aborts;
- UI remains usable afterward.

---

# 7. Phase 2 — Persistence and Conversation Model

## Allowed files

- `src/openparlor/`
- `public/openparlor/`
- `tests/openparlor/`
- `src/server-startup.js` (only when mounting an OpenParlor route)
- `.agent/local-runtime-inventory.md` (only for local-service discovery)
- `.agent/handoff.md`
Do not modify package files, inherited SillyTavern UI, unrelated files, or any GitHub workflow. Never commit or push.
