# OpenParlor Local Qwen Worker Rules

Qwen implements one bounded pass through Aider. It may edit only the exact
repository-relative file supplied for that pass and inspect directly relevant
files. It must not edit `.agent/current-task.md` or `.agent/handoff.md`, select
tasks, broaden architecture, commit, push, reset work, or change unrelated
SillyTavern/OpenParlor code. It must report its changes and checks when done.
