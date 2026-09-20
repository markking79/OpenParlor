# TASK-LOCAL-001 — Establish exact current state

## Goal

## TASK-LOCAL-001 — Establish exact current state

Inspect:

- `git status --short`
- `git log --oneline --decorate -15`
- `.agent/current-task.md`
- `.agent/handoff.md`
- `.agent/OPENPARLOR_PLAN.md`
- `.agent/CODEX_SUPERVISOR.md`
- `.agent/WORKER_RULES.md`
- current diffs under OpenParlor directories.

Acceptance:

- existing in-progress work is identified;
- no work is discarded;
- next task is dependency-safe.

## Allowed files

- `src/openparlor/`
- `public/openparlor/`
- `tests/openparlor/`
- `src/server-startup.js` (only when mounting an OpenParlor route)
- `.agent/local-runtime-inventory.md` (only for local-service discovery)
- `.agent/handoff.md`
Do not modify package files, inherited SillyTavern UI, unrelated files, or any GitHub workflow. Never commit or push.
