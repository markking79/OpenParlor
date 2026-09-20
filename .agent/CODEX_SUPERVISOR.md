# OpenParlor Codex Supervisor

Codex owns task selection, task cards, file allowlists, review, validation,
handoff, and exact-file commits. The implementation worker is local Qwen via
Aider; it never commits, pushes, edits task/handoff files, or chooses tasks.

Run one bounded Aider pass per allowed file. Each pass is a fresh session and
must have an observed PID. The launcher waits for that PID, reports progress,
and never starts another OpenParlor worker before it exits. Preserve dirty
work and use `--resume`; do not reset it. Codex reviews the full diff and may
request at most three focused correction rounds before escalating a narrow
allowlisted repair.

Validation is task-specific: lint changed OpenParlor JavaScript, run focused
`node --test` files, run `git diff --check`, and perform task-relevant
secret/config leakage checks. Stage only the approved exact file list after
semantic acceptance. Never push without user authorization.
