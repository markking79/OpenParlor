# OpenParlor Handoff

## Current state

TASK-003 is accepted. The first authenticated OpenParlor backend chat endpoint is ready for a later browser integration.

## Last completed task

TASK-003 — Authenticated OpenParlor chat endpoint.

## Important decisions

- Configuration is read exclusively from `<directories.root>/openparlor/config.json`.
- Missing, unreadable, invalid JSON, and malformed configuration return a fresh normalized disabled configuration without creating files or logging content.
- Runtime defaults never contain endpoints or secrets. The only local URL strings are non-routable-port placeholders in the checked-in example configuration required by the task card.
- Providers consume normalized model configuration supplied by callers; they do not read user configuration files directly.
- `fetch` is injectable, API keys are optional, and cancellation is represented by per-request `AbortSignal`.
- `POST /api/openparlor/chat` is mounted inside SillyTavern's already-authenticated private endpoint setup and resolves configuration only from `request.user.directories`.

## Known issues

- The repository has no `node_modules/.bin/jest`; TASK-002 uses Node's built-in test runner and adds no dependencies.
- The local Qwen terminal worker was repeatedly terminated by its 30-second execution wrapper before its first edit. Its scoped implementation was completed directly after those failed attempts.
- The focused endpoint test needs an ephemeral loopback listener and must run outside this sandbox; all provider interactions remain mocked.

## Next dependency-first task

TASK-004: add bounded streaming support to the authenticated OpenParlor chat endpoint and browser integration.

## Relevant commands

```bash
npm run lint -- --no-cache src/openparlor/chat-router.js src/server-startup.js
node --test tests/openparlor/chat-router.test.js
```

## Notes for the next session

The chat route is intentionally non-streaming and accepts only `messages`; request provider URLs, keys, models, and message extras are ignored. Do not begin TASK-004 automatically.
