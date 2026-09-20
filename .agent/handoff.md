# OpenParlor Handoff

## Current state

TASK-001 is accepted. The server-only OpenParlor configuration loader is ready for a route or provider to call.

## Last completed task

TASK-001 — Add machine-local OpenParlor configuration loading.

## Important decisions

- Configuration is read exclusively from `<directories.root>/openparlor/config.json`.
- Missing, unreadable, invalid JSON, and malformed configuration return a fresh normalized disabled configuration without creating files or logging content.
- Runtime defaults never contain endpoints or secrets. The only local URL strings are non-routable-port placeholders in the checked-in example configuration required by the task card.

## Known issues

- The repository has no `node_modules/.bin/jest`, so the focused Jest command could not run. No dependencies were installed.

## Next dependency-first task

TASK-002: implement the OpenParlor model-provider adapter that consumes the loader's `model` configuration, without adding STT, TTS, UI, or route work.

## Relevant commands

```bash
npm run lint -- --no-cache src/openparlor/config.js
node_modules/.bin/jest --config tests/jest.config.json tests/openparlor/config.test.js
```

## Notes for the next session

The accepted TASK-001 diff is limited to `src/openparlor/` and `tests/openparlor/` plus this handoff record. Use the authenticated request's existing `directories.root`; never accept a browser-provided configuration path.
