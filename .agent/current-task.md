# TASK-CHAR-004 — Prompt assembly

## Goal

Build the authoritative server-side character prompt from stored character and
conversation data. The browser must continue to send only ordinary chat
messages and conversation IDs.

## Acceptance criteria

- Deterministically assemble global behavior, character persona/system prompt,
  scenario, recent stored conversation history, and newest user content.
- Do not trust a browser-supplied system prompt or character identity.
- Bound history growth and preserve valid model roles.
- Add focused tests for ordering, role conversion, ownership, and limits.

## Exact allowlist

- `src/openparlor/prompt-builder.js` (new)
- `src/openparlor/chat-router.js`
- `tests/openparlor/prompt-builder.test.js` (new)
- `tests/openparlor/chat-router.test.js`

Do not edit OpenParlor server routes, `src/openparlor/router.js`, package files, or other
`.agent` control files. Do not stage, reset, clean, discard, or modify
unrelated existing work.
