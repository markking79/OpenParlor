# TASK-TTS-005 — Auto-speak mode

## Goal

Add a per-conversation browser auto-speak setting for new assistant replies.

## Acceptance criteria

- Expose an accessible Off/Auto-speak control in the conversation UI; its state
  applies only to the active conversation and survives a page reload safely.
- When enabled, play only a completed new assistant reply using that
  conversation's assigned character voice. Never overlap playback; a new reply
  replaces current audio.
- Explicit Stop, switching conversations, and disabling auto-speak stop audio
  and release resources. Do not auto-play historical messages on reload.
- Add deterministic UI-helper tests.

## Exact allowlist

- `public/openparlor/index.html`
- `public/openparlor/openparlor.js`
- `public/openparlor/openparlor.css`
- `tests/openparlor/openparlor-ui.test.js`

Do not edit server routes, persistence, provider/configuration implementation,
package files, or other `.agent` control files. Do not stage, reset, clean,
discard, or modify unrelated existing work.
