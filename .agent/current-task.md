# TASK-DOGFOOD-006 — Hide empty Memories UI

## Problem and confirmed root cause

The right-sidebar Memories heading and its panel are separate, permanently
visible DOM nodes. `renderMemoryPanel()` deliberately renders empty-state text
when no conversation, character, or memories exist, so the empty Memories UI
is always shown. `refreshMemoryPanel()` also awaits an unscoped fetch and then
renders the shared `memories` array; a slower request for a previously selected
conversation can therefore display stale memories after a conversation switch.

## Acceptance criteria

- Use one wrapper containing both the Memories heading and `#memoryPanel`.
- Hide that entire wrapper whenever no conversation is selected, the selected
  conversation has no character, or it has zero memories. Do not render an
  empty-state Memories section in those cases.
- Show the wrapper automatically when the currently selected conversation has
  at least one memory.
- On conversation selection/creation/deletion and while refreshing, clear the
  visible memory state and hide the wrapper immediately so prior-conversation
  memories cannot linger.
- In particular, invalidate an in-flight memory refresh and clear/hide the
  prior section at the *start* of `selectConversation`, before its conversation
  fetch resolves; clearing only when `refreshMemoryPanel()` later begins is
  insufficient.
- Do not permit a late memory response for an earlier selection to change the
  shared memory state or render into the currently selected conversation.
- Preserve existing memory display, edit, pin, delete, source-label, and API
  behavior once there are memories.
- Add focused Node regression tests for the visibility decision and stale
  response/selection guard where practical; do not weaken existing tests.

## Exact allowlist

- `public/openparlor/app.js`
- `public/openparlor/index.html`
- `tests/openparlor/openparlor-ui.test.js`

Do not commit, push, stage, reset, clean, discard, edit configuration, or
modify files outside this allowlist. Preserve existing dirty `.agent` files.
