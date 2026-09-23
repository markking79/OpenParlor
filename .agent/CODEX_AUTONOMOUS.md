# OpenParlor Codex Supervisor — Dogfood Repair Batch 001

You are the engineering supervisor for OpenParlor.

You are NOT the primary implementation worker.

The local Qwen model, through Aider, should perform most code edits. Your job is to inspect the repository, diagnose issues, define narrow tasks, supervise Qwen, review every change, run tests, request corrections, and accept/commit work only when it is correct.

## Worker

Use the existing local Qwen/Aider worker configuration.

Local OpenAI-compatible model endpoint:

http://127.0.0.1:8080/v1

Qwen must NOT:
- choose its own roadmap
- commit
- push
- rewrite unrelated areas
- weaken tests just to make them pass

Codex is the authority for:
- root-cause analysis
- task selection
- acceptance criteria
- file allowlists
- reviewing Qwen output
- regression testing
- acceptance
- committing accepted work

Do not push.

---

# DOGFOOD TASK ORDER

Work on ONE task at a time.

Do not begin the next task until the current task has been reviewed, tested, accepted, and committed.

Order:

1. DOGFOOD-001 — Persisted group-message speaker identity
2. DOGFOOD-002 — Group addressing and multi-speaker streaming
3. DOGFOOD-003 — Rename/delete conversations
4. DOGFOOD-004 — Panel scrolling and chat autoscroll
5. DOGFOOD-005 — Collapsible left/right sidebars
6. DOGFOOD-006 — Hide empty Memories UI
7. DOGFOOD-007 — Estimated response-start progress

---

# DOGFOOD-001 — Persisted group-message speaker identity

Real-world bug:

After refreshing OpenParlor and reopening a group conversation containing multiple AI characters, messages from different AI characters can all appear to belong to the same character.

Inspect the current implementation and confirm the root cause before editing.

Known likely cause:

- persisted messages store `participant_id`
- conversation participants map participant IDs to character IDs
- live streaming messages may contain `character_id`
- browser rendering can fall back to `currentConversation.characterId`
- participant normalization may currently discard the participant record ID

Acceptance requirements:

- preserve participant record IDs when normalizing conversation participants
- persisted character messages must resolve:
  `message.participant_id -> conversation participant -> character_id`
- live stream messages with explicit `message.character_id` must continue to work
- only fall back to the primary character when identity truly cannot be resolved
- after page refresh, each AI message displays the correct:
  - character name
  - avatar
  - TTS/replay voice
- add regression tests with at least two characters and persisted messages from both
- no unrelated changes

After acceptance:
- run focused tests
- run appropriate full OpenParlor tests
- run lint
- run `git diff --check`
- review the semantic diff
- commit locally
- update `.agent/handoff.md`
- then proceed to DOGFOOD-002

---

# DOGFOOD-002 — Group addressing and multi-speaker streaming

Observed real-world behavior:

In a two-character group chat, the user typed:

`hey guys`

One character initially appeared to be typing, the avatar changed to the other character, and when generation finished only one character's response appeared.

Requirements:

## Collective addressing

Treat obvious group-address phrases as whole-group intent.

At minimum support:

- `hey guys`
- `hi guys`
- `hello guys`
- `you guys`
- `what do you guys think`
- equivalent obvious uses of `folks`

Preserve existing support for:

- everyone
- everybody
- all of you
- you all
- both
- both of you
- you two

Avoid broad false positives.

For example, merely saying:

`I saw those guys yesterday`

must not automatically address every AI character.

In a two-character conversation:

`hey guys`

must select both characters.

## Pending speaker UI

Before the server emits `speaker_start`, do NOT display the primary character's name or avatar as though that character is already responding.

Use a neutral state such as:

`Preparing response…`

or:

`Selecting speaker…`

Once `speaker_start` arrives, replace the neutral state with the correct character identity.

## Multi-speaker streaming correctness

A stream containing:

- speaker_start for character A
- deltas for A
- speaker_end for A
- speaker_start for character B
- deltas for B
- speaker_end for B

must leave TWO separate messages visible.

Character B must never replace or erase character A's completed response.

After reload, both persisted messages must still show the correct identity using DOGFOOD-001 behavior.

Add focused regression coverage.

---

# DOGFOOD-003 — Rename and delete conversations

The backend already supports conversation update and deletion.

Do not create duplicate endpoints.

## Rename

Add a UI action for renaming conversations.

Requirements:

- rename control available from conversation list
- edit without leaving the page
- trim title
- reject empty title client-side
- use existing PATCH conversation endpoint
- update sidebar title after success
- update current chat header after success
- preserve messages, participants, memories, settings, and conversation ID

## Delete

Add a conversation delete control.

Requirements:

- clear confirmation before deletion
- use existing DELETE endpoint
- remove from list without full page reload
- if current conversation is deleted:
  - stop playback
  - stop/cancel pending response UI
  - clean relevant recording/stream state
  - clear messages
  - clear participants
  - clear memory UI
  - select another conversation if appropriate, otherwise show empty state
- remove conversation-specific localStorage values such as Auto-speak and Voice mode where appropriate

Add tests.

---

# DOGFOOD-004 — Panel scrolling and chat autoscroll

All three main columns must work correctly within the viewport.

Requirements:

## Left panel
- independently vertically scrollable

## Center panel
- messages independently vertically scrollable
- chat header remains usable
- participants bar remains usable
- composer remains usable

## Right panel
- independently vertically scrollable

Use correct CSS grid/flex constraints such as `min-height: 0` where necessary.

Avoid accidental full-page double scrollbars on normal desktop layouts.

## Chat autoscroll

Scroll to newest content:

- when opening a conversation
- after user sends a message
- during streamed assistant text
- when a second group speaker begins

Use reliable post-layout scrolling.

If needed use `requestAnimationFrame()` rather than relying on immediate `scrollTop` assignments before rendering completes.

Do not introduce aggressive autoscroll behavior that breaks basic message rendering.

Add appropriate tests.

---

# DOGFOOD-005 — Collapsible sidebars

Both left and right panels must be independently hideable.

Requirements:

- obvious collapse control on left
- obvious collapse control on right
- collapsed panel leaves a small visible control/rail for restoring it
- center chat expands into freed space
- do not destroy sidebar DOM/state when collapsed
- preserve sidebar scroll position
- persist each sidebar's collapsed state in localStorage
- restore preference after reload
- controls keyboard accessible
- appropriate aria-labels
- modest animation is fine if robust

Add focused browser/UI tests where practical.

---

# DOGFOOD-006 — Hide empty Memories UI

Current UI shows an empty section like:

Memories

Select a conversation to view memories.

The user does not want this visible unless there are actual memories.

Requirements:

Hide the entire Memories section when:

- no conversation is selected
- selected conversation has zero memories
- user switches from a conversation with memories to one without memories
- memories are being refreshed and stale memories belong to a previous conversation

Show the section automatically when the selected conversation has at least one memory.

Prefer controlling visibility through one wrapper containing:

- Memories heading
- memory panel

Do not leave stale memory content visible during conversation changes.

Add tests.

---

# DOGFOOD-007 — Estimated response-start progress

The user wants a rough indication of how long it may take before visible model output begins.

This must be honest.

The model does NOT provide true percentage-complete information, so never present this as real model progress.

Requirements:

Before speaker identity is known show:

`Preparing response…`

Once a speaker is known, allow something like:

`Monica · ~45%`

The `~` indicates estimated progress.

Use a small local timing model based on previously observed time-to-first-token.

Acceptable implementation:

- rolling average or EMA
- bounded history
- harmless timing statistics only
- browser-local storage is acceptable
- no telemetry
- no extra model calls
- no backend polling system just for progress

Behavior:

- start at a sensible low percentage
- progress gradually
- cap waiting progress around 90–95%
- never show 100% before first visible token
- remove progress immediately when first visible token arrives
- cancel timers on:
  - abort
  - conversation switch
  - error
  - completion
- sequential group speakers need independent pending progress states
- do not make one character avatar silently morph into another character

Add focused tests.

---

# SUPERVISION PROCEDURE FOR EVERY TASK

For each task:

1. Inspect current repository state.
2. Verify the reported bug/root cause.
3. Update `.agent/current-task.md` with:
   - problem
   - root cause
   - exact acceptance criteria
   - explicit file allowlist
4. Delegate the narrow implementation to Qwen/Aider.
5. Inspect every changed file.
6. Review semantic behavior, not merely test output.
7. Run focused tests.
8. Run broader OpenParlor tests where appropriate.
9. Run lint.
10. Run `git diff --check`.
11. Request a Qwen correction pass for defects.
12. Repeat review until accepted.
13. Commit only after acceptance.
14. Update `.agent/handoff.md`.
15. Proceed to the next dogfood task.

Do not allow Qwen to commit.

Do not push.

Do not modify local model/TTS/STT/provider configuration.

Do not rewrite SillyTavern core unless clearly necessary.

Prefer changes inside:

- `public/openparlor/`
- `src/openparlor/`
- `tests/openparlor/`
- `.agent/`

Preserve existing:

- character-card compatibility
- character memory/privacy behavior
- conversation summaries
- prompt budgeting
- TTS
- STT
- streaming
- multi-character behavior
- provider security boundaries

If tests reveal an unrelated upstream SillyTavern failure, document it rather than modifying unrelated upstream code.

If a genuine ambiguity or regression blocks safe progress, mark the workflow blocked and explain why.

When all DOGFOOD-001 through DOGFOOD-007 are accepted, set the supervisor status to `plan_complete` and STOP.

Never push.
