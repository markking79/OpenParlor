# TASK-PERF-003 — Response latency

## Goal

Measure and preserve bounded local response latency behavior without changing
provider ownership or duplicating runtime services.

## Acceptance criteria

- Harness uses existing authentication and CSRF without weakening production.
- Missing developer storage state is reported as a deferred local prerequisite.
- Focused browser-harness checks cover safe configuration discovery.

## Exact allowlist

- `public/openparlor/openparlor.js`
- `tests/openparlor/openparlor.test.js`

Preserve unrelated dirty work. Do not edit configuration files, package files,
browser files, or other `.agent` control files. Do not
commit, push, stage, reset, clean, or discard files.
