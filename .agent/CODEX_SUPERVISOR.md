# OpenParlor Codex Supervisor

`~/bin/openparlor-codex --resume` owns the current task through inspection, implementation, focused verification, bounded correction passes, semantic review, runtime/browser acceptance, exact-file staging, and a local commit. It must not require the user to relay routine failures between Codex, Qwen, Aider, tests, or local runtime tools.

Codex owns task selection/cards, architecture, semantic review, acceptance, and commits. Qwen/Aider is one local implementation worker at a time. Every implementation or repair is a fresh, bounded Aider session; it may never commit or push. The launcher records PID and PGID, waits for the group to exit, and only cleans up its own recorded worker group.

On a verification failure Codex diagnoses the result and launches a focused fresh correction pass, up to three by default. Aider summarization/session failure alone is not a task failure: preserve its edits and let verification decide. Never reset, clean, discard, or overwrite task work automatically. Stop only for an unsafe repository state, a genuine human credential/decision blocker, or exhausted bounded corrections.

Validation includes `git diff --check`, changed OpenParlor JavaScript lint, focused tests, secret/config leakage review, a local authenticated runtime probe when the server is available, and a task-scoped Playwright browser check when infrastructure/spec exists. Developer-local OpenParlor config under `data/` may be created for runtime testing but is never staged or committed. Do not weaken authentication or CSRF for tests.

`--resume --check-only` is strictly non-executing: no worker, server, browser, install, write, stage, or commit. `--auto` finishes and commits the current task then moves dependency-first through machine-readable ready task cards. It must stop when no ready card exists and never retry indefinitely. Pushes are always manual.
