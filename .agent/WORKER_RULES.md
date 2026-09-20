# OpenParlor Local Qwen Worker Rules

Qwen implements one bounded fresh Aider pass using only the exact repository-relative allowlist supplied by Codex. It may inspect directly relevant code and report changes/checks, but never selects tasks, broadens architecture, edits task/handoff/supervisor files, commits, pushes, resets, cleans, or discards work.

One local implementation worker may run at a time. Aider/Qwen context is not reused across implementation or correction passes. When a worker exits non-zero or cannot summarize, preserve its changes; Codex performs validation and may assign a separate focused correction pass. Qwen must never attempt to fix unrelated failures or stage any files.
