# QWEN-GROUP-001 Report — Fix Multi-Character/Group Chat Correctness

## Task

TASK QWEN-GROUP-001 from `OPENPARLOR_QWEN_ONLY_STABILIZATION_PLAN.md`: fix
multi-character/group chat correctness (speaker selection, speaker identity in
prompts and UI, and history duplication) with a bounded, test-proven change.

## Starting commit

- `47da003f2daf0c18ab1ae991a955c8e3e2844bfe` (`openparlor-main` HEAD)

## Working branch

- `qwen-autonomous-stabilization` (created from `openparlor-main`; `openparlor-main` untouched)

## Final commit SHA

- `0d67e99ed407daa73b8798222d43d86bd4c469e5` (this report is part of that commit;
  the SHA was backfilled into the working copy after the commit)

## Root causes found (verified against the code before editing)

1. **No whole-group intent in speaker selection** (`src/openparlor/speaker-director.js`):
   `selectSpeaker` only matched explicit names, so "everyone say hello" fell
   back to the first participant and only one character responded.
2. **Anonymous assistant history in prompts** (`src/openparlor/prompt-builder.js`):
   every stored `character` message was mapped to the anonymous `assistant`
   role, so a character's own generation prompt contained other characters'
   previous speech as if it were its own.
3. **Unreadable participant list in prompts** (`src/openparlor/prompt-builder.js`
   + `src/openparlor/chat-router.js`): `chat-router` passed the raw persisted
   participant records (no `name` field) into `participantsRule`, which
   stringified them as `[object Object]`.
4. **First group bubble shows the wrong identity** (`public/openparlor/openparlor.js`):
   the assistant placeholder was rendered with the conversation's primary
   character before the server's `speaker_start` record arrived, and the UI
   never re-rendered when the first `speaker_start` set the real identity.
5. **History duplication** (`public/openparlor/openparlor.js`): the browser
   resent the entire local `currentMessages` array with every request, so
   persisted history was sent again on top of the server-loaded history.

## Files changed

Production (all on the §15 allowlist):

- `src/openparlor/speaker-director.js` — bounded whole-group cues
  (`everyone`, `everybody`, `all of you`, `you all`; plus `both`, `you two`
  when exactly two character participants exist), checked before name
  matching; participant order preserved.
- `src/openparlor/prompt-builder.js` — new optional `participantContext`
  input (`{participant_id, character_id, name}[]`); participant list now uses
  resolved names (strings or `{name}` objects; unreadable entries dropped, so
  `[object Object]` can never reach the prompt); speaker-relative history:
  the target character's own stored speech stays `assistant`, other
  characters' stored speech becomes a labeled user context line
  (`[Name said to the group]: ...`); legacy mapping retained when no context
  or `participant_id` is available; a short group-context instruction is
  added when more than one participant is listed.
- `src/openparlor/chat-router.js` — builds and passes `participantContext`
  (participant id + character id + resolved display name) into `buildPrompt`.
- `public/openparlor/openparlor.js` — new pure, exported
  `createStreamMessageCollector()` state machine (first `speaker_start`
  assigns identity to the pending message, later ones start new messages,
  deltas/errors append to the current message); `sendMessage` now sends only
  the new user turn (`[{role:'user',content:text}]`) instead of the full
  local history, and re-renders on every `speaker_start` so the
  server-identified speaker is displayed before the first text delta.

## Tests added (failing first, then made to pass)

Written before the fix and confirmed to fail for the right reason:

- speaker-director: `everyone` / `everybody` / `all of you` / `you all`
  select all participants; `both of you` / `you both` / `you two` / bare
  `both` select both in a two-character chat only; explicit names still
  select only the named character; group cue takes precedence over an
  explicit name; `"That's all I wanted to say"` does NOT select the group;
  generic turns keep the deterministic first-participant fallback.
- prompt-builder: for Monica, her own stored line is `assistant` and Doug's
  line is a user-role line attributed to Doug (and the inverse for Doug);
  participant names render readably (context precedence over raw records;
  raw `{name}` records); legacy history without `participant_id` stays
  `assistant`; single-character prompt without context is unchanged.
- chat-router: `everyone` stream turn calls the provider once per speaker
  with speaker-specific prompts, persists the user message exactly once,
  stores each character reply under the correct participant id, and ends
  with `done`; the system prompt lists real participant names (no
  `[object Object]`); persisted history + new question each appear exactly
  once in the provider prompt; persisted speaker identity survives for the
  selected speaker (Doug's line labeled `[Doug said to the group]` in
  Monica's prompt).
- openparlor-ui: `createStreamMessageCollector` — first `speaker_start`
  determines the pending message identity; two streamed speakers produce
  two distinct messages with distinct identities; pre-`speaker_start` deltas
  attach to the pending message; error records append safe error lines;
  unknown/malformed records are ignored.

Test file changes (all on the §15 allowlist):

- `tests/openparlor/speaker-director.test.js` — 15 new tests.
- `tests/openparlor/prompt-builder.test.js` — 6 new tests.
- `tests/openparlor/chat-router.test.js` — 4 new tests.
- `tests/openparlor/openparlor-ui.test.js` — 6 new tests
  (`createStreamMessageCollector` describe block).
- `tests/openparlor/openparlor-stream.test.js` — harness fix only: the loader
  used `vm.runInNewContext` on an ESM file and the whole suite failed at
  baseline; it now imports `createNdjsonParser` from the module directly.
  No assertion was changed.

## Commands run

```bash
node --test tests/openparlor/speaker-director.test.js
node --test tests/openparlor/prompt-builder.test.js
node --test tests/openparlor/chat-router.test.js
node --test tests/openparlor/openparlor-stream.test.js
node --test tests/openparlor/openparlor-ui.test.js
node --test tests/openparlor/openparlor.test.js
npm run lint -- --no-cache src/openparlor/speaker-director.js src/openparlor/prompt-builder.js src/openparlor/chat-router.js public/openparlor/openparlor.js
git diff --check
git diff --cached --check
```

## Results

- speaker-director.test.js: 26/26 pass (11 pre-existing + 15 new)
- prompt-builder.test.js: 31/31 pass (25 pre-existing + 6 new)
- chat-router.test.js: 57/57 pass (53 pre-existing + 4 new)
- openparlor-stream.test.js: 9/9 pass (baseline had 1 harness failure; fixed)
- openparlor-ui.test.js: 154/155 pass (148 pre-existing passing + 6 new; 1
  pre-existing baseline failure, see below)
- openparlor.test.js: 214/214 pass
- lint: clean (no errors or warnings on the allowlisted files; the lint
  script also lints the rest of the tree, which is clean)
- `git diff --check` and `git diff --cached --check`: clean

### Pre-existing baseline failures (present before any edit; not caused by this task)

- `openparlor-ui.test.js` → `normalizeConversation` → "normalizes a valid
  conversation": `normalizeConversation` now returns an extra
  `participants: []` field that the old deep-equal expectation does not
  include. Unrelated to group-chat speaker identity/routing; recorded per
  plan §3.2 and intentionally left untouched to keep this change bounded.


## Known limitations

- Whole-group intent is matched with a small bounded cue list
  (`everyone`, `everybody`, `all of you`, `you all`, and the two-person
  `both`/`you two` forms). Free-form phrasings outside this list still use
  name matching or the deterministic first-participant fallback, by design.
- The "send only the new user turn" browser change relies on the server
  being the source of persisted history (it already was: the server persists
  the user turn and loads stored history itself). Standalone
  (no-`conversation_id`) requests are unchanged.
- Group TTS uses per-message `character_id`, which the collector now sets for
  the first speaker as well; no TTS code was modified.
- Runtime/browser E2E was not executed (no authenticated local service
  state was available); behavior is proven by the unit/integration tests
  above per plan §19.

## Mandatory self-review (§18)

1. Does `everyone say hello` select all character participants? **Yes** —
   `GROUP_WIDE_CUES` check in `selectSpeaker` returns all character
   participants in participant order (tested).
2. Does `Monica, what do you think?` select Monica only? **Yes** — no group
   cue matches; name matching selects only Monica (tested).
3. Does a generic unnamed turn retain deterministic fallback? **Yes** — rule
   5 (first character participant) is unchanged (tested).
4. Does Monica see Doug's previous speech as Doug's speech rather than
   Monica's? **Yes** — speaker-relative history maps other characters'
   stored lines to labeled user context lines
   `[Doug said to the group]: ...` (tested at prompt-builder and
   chat-router level).
5. Does the system prompt list actual participant names? **Yes** —
   `chat-router` resolves display names into `participantContext`;
   `normalizeParticipantNames` guarantees only readable names reach the
   prompt (tested; `[object Object]` assertions pass).
6. Is the newest user message included exactly once? **Yes** — the browser
   sends only the new user turn; the server appends `newMessages` once after
   loading persisted history (counted exactly-once in tests).
7. Does browser `speaker_start` determine first bubble identity? **Yes** —
   the first `speaker_start` assigns `character_id` to the pending message
   and the UI re-renders on every `speaker_start`, before any delta text
   (tested via `createStreamMessageCollector`).
8. Can two speakers produce two separate visible messages? **Yes** — later
   `speaker_start` records start new message objects that are pushed into
   `currentMessages` and rendered (tested).
9. Are persisted character responses stored under correct participant IDs?
   **Yes** — server persistence per speaker participant is unchanged and
   asserted by the new stream test (tested).
10. Does memory extraction retain correct source message IDs? **Yes** —
    extraction logic was not modified; it still keys off the persisted
    speaker message id (existing tests pass unchanged).
11. Does group TTS still have the correct per-message `character_id`?
    **Yes** — each streamed message object carries its own `character_id`
    (now set for the first speaker too); TTS code untouched.
12. Are provider URLs/API keys still entirely server-controlled? **Yes** —
    no provider, config, or request-destination changes.
13. Did any unrelated SillyTavern files change? **No** — only the four
    allowlisted production files, the five allowlisted test files, and this
    report.
14. Did any test get deleted or weakened? **No** — only additions; the one
    stream-test change is a harness loader fix for a suite that failed at
    baseline (assertions unchanged).
15. Is there any debugging code left behind? **No** — no console/debugger
    additions; `git diff --check` clean.

## Worktree clean status

- Clean at commit time: after the commit only the untracked
  `OPENPARLOR_QWEN_ONLY_STABILIZATION_PLAN.md` (present before work began)
  remained. The only post-commit working-copy change is this report's final
  commit SHA backfill (uncommitted, intentional).
