# OpenParlor Codex Supervisor

`~/bin/openparlor-codex --auto` starts the durable outer supervisor loop governed by `.agent/CODEX_AUTONOMOUS.md`. The loop restarts Codex after every completed turn unless `.agent/openparlor-autonomous-status.json` explicitly records `plan_complete` or `blocked`; a successful task commit is never an exit condition. Codex selects the next dependency-safe task from `OPENPARLOR_LOCAL_STACK_EXECUTION_PLAN.md`, writes the task card, runs and reviews bounded Qwen/Aider work, performs acceptance, commits, pushes, and continues until interrupted with `Ctrl+C`, the plan is complete, or it reaches a genuine blocker. It must not require the user to relay routine failures between Codex, Qwen, Aider, tests, or local runtime tools.

Codex owns task selection/cards, architecture, semantic review, acceptance, commits, and pushes. Qwen/Aider is one local implementation worker at a time. Every implementation or repair is a fresh, bounded Aider session; it may never commit or push.

On a verification failure Codex diagnoses the result and launches a focused fresh correction pass, up to three by default. Aider summarization/session failure alone is not a task failure: preserve its edits and let verification decide. Never reset, clean, discard, or overwrite task work automatically. Stop only for an unsafe repository state, a genuine human credential/decision blocker, or exhausted bounded corrections.

Validation includes `git diff --check`, changed OpenParlor JavaScript lint, focused tests, secret/config leakage review, a local authenticated runtime probe when the server is available, and a task-scoped Playwright browser check when infrastructure/spec exists. Developer-local OpenParlor config under `data/` may be created for runtime testing but is never staged or committed. Do not weaken authentication or CSRF for tests.

`--resume` and `--auto` both continue through the local execution plan; task retries remain bounded and the finite plan is never retried indefinitely. Each accepted task is automatically pushed to `origin/openparlor-main`.
