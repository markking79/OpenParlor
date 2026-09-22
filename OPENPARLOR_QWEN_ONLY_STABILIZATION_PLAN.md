# OpenParlor Qwen-Only Stabilization and Next-Steps Plan

**Repository:** `/home/mark/openparlor`  
**Target branch:** `openparlor-main` (create a safety branch before editing; see Phase 0)  
**Purpose:** Test whether the local Qwen model can act as the primary developer for OpenParlor without Codex supervising routine work.  
**Date prepared:** 2026-09-22

---

# 0. How to Use This Plan

This document is intentionally explicit. Qwen should treat it as an execution specification, not as a brainstorming prompt.

The immediate experiment is:

1. Qwen reads the repository and this plan.
2. Qwen creates a safe working branch.
3. Qwen fixes the current multi-character/group-chat correctness problems.
4. Qwen writes regression tests.
5. Qwen runs all required focused verification.
6. Qwen performs its own code review.
7. Qwen commits the accepted group-chat fix.
8. Qwen STOPS after the first task and produces a report.

The user will then inspect the result and decide whether Qwen should continue autonomously through the rest of this plan.

**Do not run Codex during this trial.**

The first task is deliberately chosen because it requires reasoning across:

- server-side speaker selection;
- persisted conversation history;
- prompt assembly;
- browser streaming;
- character identity;
- group TTS metadata;
- tests.

It is a good measure of whether Qwen can do more than make a narrow local edit.

---

# 1. Qwen Operating Contract

## 1.1 Qwen owns the task

For this experiment, Qwen is responsible for:

- repository inspection;
- root-cause analysis;
- implementation;
- test design;
- lint/test execution;
- correction of failures;
- semantic review;
- local commit;
- final report.

Qwen must not rely on Codex to review or correct its work.

## 1.2 Safety rules

Qwen MUST NOT:

- run `git reset --hard`;
- run `git clean`;
- discard uncommitted work;
- overwrite unrelated user changes;
- force-push;
- modify unrelated SillyTavern code without a demonstrated need;
- weaken authentication or CSRF;
- move provider configuration into browser JavaScript;
- expose local model/STT/TTS endpoints to browser control;
- add a framework/bundler for this task;
- rewrite OpenParlor from scratch;
- change the user's llama.cpp configuration;
- start a second llama.cpp instance;
- install large new AI models;
- remove tests because they fail.

If the repository is unexpectedly dirty at the beginning, Qwen should inspect the diff. It may proceed only if the changes are clearly part of the intended current task. Otherwise stop and report the unsafe state.

## 1.3 Correction limit

For the first task:

- implementation pass: 1
- correction passes: maximum 3

If tests still fail after 3 focused correction passes, stop and report:

- failing command;
- exact failure;
- changed files;
- suspected root cause;
- what was attempted.

Do not enter an infinite loop.

## 1.4 Commit policy

For this Qwen-only experiment, Qwen MAY commit once the task meets every acceptance criterion.

Qwen MUST NOT push automatically.

Commit only task-scoped files.

Suggested commit message:

`fix group chat speaker identity and routing`

## 1.5 Reporting

Create or update:

`.agent/QWEN_ONLY_REPORT.md`

The report should contain:

- starting commit;
- working branch;
- task;
- root causes found;
- files changed;
- tests added;
- commands run;
- results;
- known limitations;
- final commit SHA;
- whether the worktree is clean.

Do not place secrets, API keys, or private conversation content in the report.

---

# 2. Known Current Architecture

Qwen must verify these facts by reading the actual current files before editing.

Important files currently include:

### Server

- `src/openparlor/chat-router.js`
- `src/openparlor/speaker-director.js`
- `src/openparlor/prompt-builder.js`
- `src/openparlor/persistence.js`
- `src/openparlor/conversation-router.js`
- `src/openparlor/character-router.js`

### Browser

- `public/openparlor/openparlor.js`
- `public/openparlor/index.html`
- `public/openparlor/openparlor.css`

### Tests

- `tests/openparlor/speaker-director.test.js`
- `tests/openparlor/prompt-builder.test.js`
- `tests/openparlor/chat-router.test.js`
- `tests/openparlor/openparlor-ui.test.js`
- `tests/openparlor/openparlor.test.js`
- `tests/openparlor/openparlor-stream.test.js`

The application currently supports:

- persisted characters;
- persisted conversations;
- multiple character participants;
- streamed model responses;
- local llama.cpp model;
- memory extraction and retrieval;
- STT;
- TTS;
- per-character voices;
- sequential group TTS;
- memory visibility by character.

Do not replace those systems. Fix their coordination.

---

# 3. Phase 0 — Preflight and Safety Checkpoint

Before editing anything:

```bash
cd ~/openparlor || exit 1

echo "=== BRANCH ==="
git branch --show-current

echo
echo "=== STATUS ==="
git status --short

echo
echo "=== HEAD ==="
git log -1 --oneline --decorate

echo
echo "=== RECENT OPENPARLOR COMMITS ==="
git log --oneline --decorate -15
```

Record the starting commit in `.agent/QWEN_ONLY_REPORT.md`.

## 3.1 Create a safety branch

If the worktree is clean and the branch `qwen-autonomous-stabilization` does not already exist:

```bash
git switch -c qwen-autonomous-stabilization
```

If that branch already exists and points at the intended starting state:

```bash
git switch qwen-autonomous-stabilization
```

Do not delete or rewrite `openparlor-main`.

The trial should be easy to compare or abandon.

## 3.2 Baseline tests

Before changing code, run the most relevant current tests:

```bash
node --test tests/openparlor/speaker-director.test.js
node --test tests/openparlor/prompt-builder.test.js
node --test tests/openparlor/chat-router.test.js
node --test tests/openparlor/openparlor-stream.test.js
```

If a test fails before Qwen edits anything, record it as a baseline failure. Do not silently attribute it to the new work.

---

# 4. TASK QWEN-GROUP-001 — Fix Multi-Character Chat Correctness

This is the first and only task Qwen should execute during the initial experiment.

After completing and committing this task, STOP.

---

# 5. Reproduction Scenario

The observed real browser scenario is:

Conversation participants:

- Doug
- Monica

User says:

`Hey, how is everyone doing? Can everyone tell me the word "hello"? I want to hear your voice`

Observed result:

- only Doug responds.

Then user says:

`Monica, why aren't you talking?`

Observed UI:

- a response appears labeled as Doug;
- the content says things consistent with Monica's context, such as a catering job;
- Monica still does not visibly appear as the speaker.

This indicates multiple distinct bugs. Qwen must fix the whole flow, not one symptom.

---

# 6. Known Root Causes to Verify

Qwen must independently confirm each root cause in current code before changing it.

Do NOT blindly edit from this document without verifying the current repository.

## 6.1 Group intent is not recognized

Current speaker selection behavior is approximately:

1. no characters -> none;
2. one character -> that character;
3. explicitly named characters -> named characters;
4. otherwise -> first character.

Therefore:

`everyone`, `everybody`, `both of you`, etc.

do not cause the whole group to speak.

Result: Doug, as the first participant, answers alone.

## 6.2 First streamed assistant bubble can have the wrong character identity

The browser currently creates an assistant placeholder before it receives the server's `speaker_start`.

The placeholder can be rendered using the conversation's primary character.

When the first `speaker_start` later identifies Monica, browser state may update the message's `character_id`, but the already-rendered name/avatar may not be rerendered.

Result:

- Monica can generate text;
- the UI can still show Doug's name/avatar.

## 6.3 Historical character messages lose speaker identity

Persisted character messages have:

- `participant_id`
- `role: "character"`
- content

The prompt builder currently maps historical character messages generically to OpenAI role `assistant`.

That collapses:

- Doug's previous message
- Monica's previous message

into a single anonymous assistant identity.

When prompting Monica, the model may interpret Doug's previous message as something Monica herself said.

This explains behavior such as Monica effectively claiming:

`I just said hello in the last message`

when Doug actually said it.

## 6.4 Participant prompt can receive participant objects rather than names

The participant rule should tell the model something like:

`Present participants in this conversation: Doug, Monica.`

Qwen must verify whether current code is instead passing raw participant records to a function that expects names.

If so, fix it so the prompt contains actual human-readable character names.

## 6.5 Browser resends too much conversation history

The browser currently appears to send the whole `currentMessages` collection on each generation request.

The server also loads persisted history.

The authoritative server prompt then risks containing:

- persisted old user messages;
- old user messages resent from the browser;
- the newest user message.

This is unnecessary and can duplicate context.

For an existing persisted conversation, the browser should normally submit the NEW user turn only. The server should own reconstruction of prior history.

---

# 7. Speaker-Selection Requirements

Modify `src/openparlor/speaker-director.js` carefully.

The goal is not yet an AI director. This task should make deterministic group intent correct.

## 7.1 Preserve existing behaviors

These must continue to work:

### One-on-one

Characters:

- Doug

Message:

`How are you?`

Expected:

- Doug selected.

### Explicit single name

Characters:

- Doug
- Monica

Message:

`Monica, what do you think?`

Expected:

- Monica only.

### Explicit multiple names

Characters:

- Doug
- Monica
- Rachel

Message:

`Doug and Monica, what do you think?`

Expected:

- Doug and Monica, in participant order.

### Unknown/general turn

Characters:

- Doug
- Monica

Message:

`What should we do today?`

For this task, preserve deterministic fallback behavior unless another existing requirement contradicts it.

It is acceptable for the default fallback to remain the first character. A more natural AI speaker director is a later task.

## 7.2 Add whole-group cues

When there are multiple characters, these phrases should select all character participants:

- `everyone`
- `everybody`
- `all of you`
- `you all`

For exactly two character participants, also support:

- `both of you`
- `you both`
- `you two`
- `both`

Be cautious with the bare word `all`; do not match unrelated text such as:

`That's all I wanted to say.`

Use bounded phrase matching.

## 7.3 Precedence

Recommended precedence:

1. validate character participants;
2. if only one -> single character;
3. detect strong whole-group cues -> all character participants;
4. detect explicit character names -> all explicitly named characters;
5. fallback -> existing deterministic first-character behavior.

This means:

`Monica, can everyone say hello?`

selects everyone because the actual request is directed to the group.

## 7.4 Tests to add

Add tests for at least:

```text
everyone say hello
everybody say hello
all of you say hello
you all say hello
both of you say hello        # 2 characters
you both say hello           # 2 characters
you two say hello            # 2 characters
Monica, what do you think?   # Monica only
Doug and Monica answer       # both
That's all I wanted to say   # does NOT imply all speakers
```

Do not remove existing tests.

---

# 8. Fix Prompt Participant Names

Qwen must make the prompt builder receive real character names.

Do not stringify participant objects.

The resulting system prompt should include something semantically equivalent to:

```text
Present participants in this conversation: Doug, Monica.
```

not:

```text
Present participants in this conversation: [object Object], [object Object].
```

## 8.1 Recommended interface

Prefer an explicit prompt input rather than making `prompt-builder.js` perform persistence lookups.

For example, extend the prompt-building inputs with one or both of:

```js
participantNames
participantNameById
```

or a pre-normalized participant context array.

Example shape:

```js
[
  {
    participant_id: "p-doug",
    character_id: "c-doug",
    name: "Doug"
  },
  {
    participant_id: "p-monica",
    character_id: "c-monica",
    name: "Monica"
  }
]
```

Keep persistence access in the chat/router layer.

Keep prompt-builder deterministic and easy to test.

---

# 9. Preserve Speaker Identity in Historical Context

This is critical.

When generating a response for Monica:

- Monica's own earlier messages may be represented as prior assistant messages.
- Doug's earlier messages MUST NOT be represented as though Monica said them.
- User messages must remain user messages.
- Other characters' names must be visible in context.

## 9.1 Recommended approach

For each generation target, build history relative to that target character.

Example stored history:

```text
User: Hi everyone
Doug: Hello!
Monica: Hi there!
User: Monica, what are you working on today?
```

When generating Monica, transform history approximately as:

```text
user: Hi everyone
user/context: [Doug said] Hello!
assistant: Hi there!
user: Monica, what are you working on today?
```

The exact transport representation can vary, but the semantic requirement is strict:

**The model must be able to distinguish the current character's own previous speech from other characters' speech.**

## 9.2 Do not rely solely on assistant message prefixes

Avoid a design like:

```text
assistant: Doug: Hello!
assistant: Monica: Hi there!
```

for a Monica generation if testing shows the model still treats both as its own prior outputs.

Prefer:

- current character's prior messages -> `assistant`;
- other characters' prior messages -> contextual `user` messages with a strong speaker label;

or another representation that tests reliably with llama.cpp/Qwen.

Example:

```js
{ role: 'user', content: '[Doug said to the group]: Hello!' }
```

This is not claiming Doug is the user; it is a transcript/context device.

A later refactor may introduce a dedicated transcript system section, but this task should make the smallest correct change.

## 9.3 Required unit test

Create history:

- User: `Hello everyone`
- Doug: `Hi, I'm Doug`
- Monica: `Hi, I'm Monica`

Build prompt for Monica.

Assert:

- Monica's own prior line appears in an assistant-role message;
- Doug's line is visibly attributed to Doug;
- Doug's line is NOT an anonymous assistant message;
- participant names are present;
- newest user turn is present exactly once.

Build prompt for Doug and assert the inverse.

---

# 10. Stop Browser History Duplication

For a persisted conversation request, the browser should send only the current user turn required for generation.

## 10.1 Current desired request

The generation request should look approximately like:

```json
{
  "conversation_id": "conversation-id",
  "messages": [
    {
      "role": "user",
      "content": "Monica, why aren't you talking?"
    }
  ],
  "stream": true
}
```

Do NOT resend:

- every previous user message;
- every previous character reply;
- the blank assistant placeholder.

The browser can still keep local messages for display.

The server remains authoritative for stored history.

## 10.2 Server behavior

The server should:

1. validate conversation ownership;
2. load persisted history;
3. inspect the newest submitted user message;
4. select speakers;
5. build a separate speaker-relative prompt for each selected character;
6. persist the submitted user message once;
7. generate responses;
8. persist each response with its actual participant ID.

## 10.3 Required test

Given persisted history containing:

```text
User: old question
Doug: old response
```

and request:

```text
User: new question
```

assert the provider prompt contains:

- old question once;
- old response once;
- new question once.

No duplication.

---

# 11. Fix First Speaker Rendering in Browser

The browser must not label the first group response as the primary character before the server identifies the speaker.

## 11.1 Required behavior

Sequence:

1. user sends a message;
2. browser may create an empty/generic pending assistant slot;
3. server sends:
   `speaker_start { character_id: Monica }`
4. browser associates the pending assistant message with Monica;
5. the visible name/avatar changes to Monica BEFORE Monica's first text delta is shown;
6. deltas append to Monica's bubble.

For second speaker:

1. server sends another `speaker_start`;
2. browser creates a new assistant message;
3. assigns that character immediately;
4. renders correct name/avatar;
5. appends deltas.

## 11.2 Important state

Every generated group message should end with:

```js
{
  role: 'assistant',
  content: '...',
  character_id: '<actual speaker character id>'
}
```

Do not rely on:

```js
currentConversation.characterId
```

when an actual streamed `character_id` is available.

## 11.3 TTS

Group TTS already depends on message character identity.

Verify that after this fix:

- Doug's response uses Doug's voice;
- Monica's response uses Monica's voice.

Do not alter the TTS architecture unnecessarily.

## 11.4 UI tests

Add a deterministic browser helper/unit test that simulates:

```text
speaker_start Monica
delta "Hello"
speaker_end Monica
done
```

and asserts the message is associated with Monica.

Also simulate:

```text
speaker_start Doug
delta "Hello from Doug"
speaker_end Doug
speaker_start Monica
delta "Hello from Monica"
speaker_end Monica
done
```

and assert two distinct messages with distinct character IDs.

If the existing test architecture does not make stream UI processing directly testable, extract the smallest pure helper necessary. Do not copy production parsing logic into tests.

---

# 12. Group Stream Contract

Do not break the existing server stream protocol.

Expected relevant records:

```json
{"type":"speaker_start","character_id":"...","participant_id":"..."}
{"type":"delta","text":"..."}
{"type":"speaker_end","character_id":"...","participant_id":"..."}
{"type":"done","conversation_id":"..."}
```

Errors may use:

```json
{"type":"error","error":"safe message","character_id":"..."}
```

The browser must remain robust to chunk boundaries.

Do not replace NDJSON in this task.

---

# 13. Persistence Correctness

For a user turn that selects Doug and Monica:

Persist exactly:

1. one user message;
2. Doug response under Doug participant ID;
3. Monica response under Monica participant ID.

Do not persist the user message twice because two characters speak.

Do not use the first speaker's participant ID as proof of the user's identity; if the existing schema uses a placeholder participant ID for user messages, preserve current schema behavior unless changing it is required for correctness.

## 13.1 Required server test

Mock two selected speakers.

Verify:

- provider called twice;
- each call gets speaker-specific prompt;
- `appendMessage` for user occurs once;
- character message for Doug uses Doug participant ID;
- character message for Monica uses Monica participant ID;
- final stream has `done`.

---

# 14. Memory Extraction After Group Responses

Do not redesign memory in this task, but verify the group fix does not make memory worse.

For group participants Doug + Monica:

- `known_by_character_ids` should still include characters who were present;
- extraction for Doug must receive Doug's generated response;
- extraction for Monica must receive Monica's generated response;
- source message ID must match the correct persisted character message;
- a failed speaker must not cause a fabricated memory extraction.

Add/retain tests if the current chat-router tests already cover this boundary.

---

# 15. Files Allowed for QWEN-GROUP-001

Preferred production allowlist:

- `src/openparlor/speaker-director.js`
- `src/openparlor/prompt-builder.js`
- `src/openparlor/chat-router.js`
- `public/openparlor/openparlor.js`

Preferred tests:

- `tests/openparlor/speaker-director.test.js`
- `tests/openparlor/prompt-builder.test.js`
- `tests/openparlor/chat-router.test.js`
- `tests/openparlor/openparlor-ui.test.js`
- `tests/openparlor/openparlor.test.js`
- `tests/openparlor/openparlor-stream.test.js`

Report:

- `.agent/QWEN_ONLY_REPORT.md`

Qwen may edit fewer files.

If Qwen believes another production file is required, it must first explain in the report why the task cannot be correctly solved within this set.

Do not edit persistence format unless a demonstrated blocker requires it.

---

# 16. Implementation Order for QWEN-GROUP-001

Use this order.

## Step 1 — Read current implementations

Read:

```bash
sed -n '1,260p' src/openparlor/speaker-director.js
sed -n '1,320p' src/openparlor/prompt-builder.js
sed -n '1,520p' src/openparlor/chat-router.js
```

Inspect relevant browser sections:

```bash
grep -n "async function sendMessage" -A220 public/openparlor/openparlor.js
grep -n "function renderMessages" -A180 public/openparlor/openparlor.js
grep -n "speaker_start" -n public/openparlor/openparlor.js
```

Read focused tests.

## Step 2 — Write failing regression tests first

Add tests that demonstrate:

- `everyone` selects all;
- `both of you` selects both in a 2-character chat;
- Monica explicit name selects Monica;
- participant names become readable prompt text;
- Doug history is not treated as Monica's assistant history;
- newest request user message appears once;
- first `speaker_start` controls displayed character identity;
- two streamed speakers produce two distinct messages.

Run them and confirm expected failures.

Do not make a test pass by weakening its assertion.

## Step 3 — Fix speaker selection

Make the smallest deterministic change.

Run:

```bash
node --test tests/openparlor/speaker-director.test.js
```

Do not proceed until speaker-selection tests pass.

## Step 4 — Fix prompt speaker identity and participant names

Update prompt-building inputs/logic.

Run:

```bash
node --test tests/openparlor/prompt-builder.test.js
```

Do not proceed until prompt tests pass.

## Step 5 — Fix chat-router construction

Construct:

- participant identity/name context;
- speaker-relative history/prompt.

Ensure request history is not duplicated.

Run:

```bash
node --test tests/openparlor/chat-router.test.js
```

## Step 6 — Fix browser request payload

Send only the new user turn for persisted conversation generation.

Do not include placeholder assistant messages in request.

## Step 7 — Fix streamed first-speaker UI identity

Make `speaker_start` authoritative for character identity.

Run browser helper tests.

## Step 8 — Run all focused tests

See section 17.

## Step 9 — Self-review full diff

See section 18.

## Step 10 — Commit

Only after every acceptance criterion passes.

---

# 17. Verification Commands

At minimum run:

```bash
cd ~/openparlor || exit 1

npm run lint -- --no-cache   src/openparlor/speaker-director.js   src/openparlor/prompt-builder.js   src/openparlor/chat-router.js   public/openparlor/openparlor.js

node --test tests/openparlor/speaker-director.test.js
node --test tests/openparlor/prompt-builder.test.js
node --test tests/openparlor/chat-router.test.js
node --test tests/openparlor/openparlor-stream.test.js
node --test tests/openparlor/openparlor-ui.test.js
node --test tests/openparlor/openparlor.test.js

git diff --check
```

If one of the large browser-helper suites has an inherited warning but no test failure, record it accurately.

Do not claim a warning is an error.

Do not claim a failing test passed.

---

# 18. Mandatory Qwen Self-Review

Before commit, Qwen must inspect the full task diff.

Answer these questions in `.agent/QWEN_ONLY_REPORT.md`:

1. Does `everyone say hello` select all character participants?
2. Does `Monica, what do you think?` select Monica only?
3. Does a generic unnamed turn retain deterministic fallback?
4. Does Monica see Doug's previous speech as Doug's speech rather than Monica's?
5. Does the system prompt list actual participant names?
6. Is the newest user message included exactly once?
7. Does browser `speaker_start` determine first bubble identity?
8. Can two speakers produce two separate visible messages?
9. Are persisted character responses stored under correct participant IDs?
10. Does memory extraction retain correct source message IDs?
11. Does group TTS still have the correct per-message `character_id`?
12. Are provider URLs/API keys still entirely server-controlled?
13. Did any unrelated SillyTavern files change?
14. Did any test get deleted or weakened?
15. Is there any debugging code left behind?

If any answer is unsatisfactory, fix it before committing.

---

# 19. Optional Real Runtime Test

If local services are already running and user authentication state is available, Qwen should perform a real runtime check.

Do not block the task solely because automated authenticated browser state is unavailable.

Recommended scenario:

Characters:

- Doug
- Monica

Create/open a conversation containing both.

### Turn 1

User:

`Everyone say hello, one at a time.`

Expected:

- Doug bubble with Doug identity;
- Monica bubble with Monica identity;
- both contain responses;
- order deterministic by participant order;
- no bubble is mislabeled.

### Turn 2

User:

`Monica, what are you doing today?`

Expected:

- only Monica responds;
- Monica bubble is labeled Monica;
- Monica does not claim Doug's earlier response was hers.

### Turn 3

User:

`Doug, what did Monica just say?`

Expected:

- Doug receives group context containing Monica's speech;
- Doug can refer to Monica's prior statement;
- Doug does not claim he was the speaker.

### TTS

If both characters have assigned voices:

- play Doug response -> Doug voice;
- play Monica response -> Monica voice;
- Auto-speak should queue them, not overlap.

Record whether runtime testing was performed.

---

# 20. Commit and Stop

If everything passes:

```bash
git status --short
git diff --check
```

Stage only files actually changed for this task, including `.agent/QWEN_ONLY_REPORT.md`.

Run:

```bash
git diff --cached --check
git diff --cached --stat
```

Commit:

```bash
git commit -m "fix group chat speaker identity and routing"
```

Then:

```bash
git status --short
git log -1 --oneline --decorate
```

**STOP HERE FOR THE INITIAL QWEN-ONLY EXPERIMENT.**

Do not continue automatically to Task 2 until the user reviews the result.

---

# 21. Acceptance Criteria for the Initial Experiment

The initial Qwen-only trial is successful only if all are true:

- Qwen completed without Codex;
- Qwen did not require the user to relay routine prompts;
- Qwen fixed all major group correctness issues, not just the `everyone` selector;
- relevant tests pass;
- lint passes;
- diff check passes;
- no destructive Git action occurred;
- no provider/auth security boundary was weakened;
- group chat correctly identifies the actual speaker;
- prior speech remains attributed to the right character;
- request history is not duplicated;
- a clean commit exists on the safety branch;
- `.agent/QWEN_ONLY_REPORT.md` clearly describes the result.

---

# 22. What Comes Next If Qwen Passes the Trial

The remaining sections are the stabilization roadmap.

Qwen should NOT execute these during the first trial. They are here so the next work is already specified.

---

# 23. TASK QWEN-STAB-002 — Character Deletion/Data Integrity

## Problem

Current character deletion removes the character record, but conversations, participant references, memories, and uploaded avatar resources may continue to refer to the deleted character.

## Goal

Define and implement a safe deletion policy.

## Recommended policy

Prefer soft deletion/archive for characters that have conversation history.

Possible behavior:

- character gets `archived: true`;
- hidden from normal new-chat selection;
- historical chats still render character name/avatar;
- memories remain attributable;
- explicit permanent purge can be a future advanced action.

For characters with no history, hard delete may remain possible.

## Requirements

- no dangling participant IDs;
- no broken conversation rendering;
- no accidental deletion of unrelated conversation history;
- memory provenance remains readable;
- UI clearly communicates archive/delete semantics;
- tests cover referenced and unreferenced characters.

## Acceptance

Create character -> chat -> memory -> delete/archive -> old conversation still loads and remains understandable.

---

# 24. TASK QWEN-STAB-003 — Clean Router Duplication

## Problem

OpenParlor has dedicated routers for some domains while `src/openparlor/router.js` still contains overlapping character/conversation/message routes plus memory/settings behavior.

This creates maintenance ambiguity.

## Goal

One canonical route implementation per API.

## Target structure

Prefer:

- `character-router.js`
- `conversation-router.js`
- `memory-router.js`
- `settings-router.js`
- `chat-router.js`
- `model-status-router.js`
- `tts-router.js`
- `stt-router.js`

Remove duplicate CRUD routes only after tests prove the dedicated equivalents cover them.

## Requirements

- no URL behavior regression;
- auth/ownership checks preserved;
- CSRF remains intact;
- server-startup mounts each router once;
- tests updated.

---

# 25. TASK QWEN-STAB-004 — Memory Quality Improvements

Do this after group identity is correct, because incorrect speaker identity contaminates memory.

## Goals

Improve:

- duplicate detection;
- relevance;
- meta-memory rejection;
- provenance.

## Problems to target

Avoid low-value memories such as:

`The user is in a group chat that includes Monica.`

unless there is a real durable relationship fact.

Preserve useful continuity facts such as:

`Monica works in catering.`

when appropriate.

## Retrieval improvements

Current lexical overlap can miss semantic equivalents.

Before adding a vector database, improve lightweight retrieval with:

- normalized tokens;
- simple stemming where safe;
- stopword filtering;
- phrase/entity matches;
- pinned memory boost;
- importance/confidence weighting;
- recency weighting;
- proper-name boost.

Keep retrieval bounded.

## Semantic retrieval later

If lightweight retrieval proves insufficient, add optional local embeddings as a separate task.

Do not introduce a heavy vector database prematurely.

---

# 26. TASK QWEN-STAB-005 — Conversation Summaries and Token Budgeting

## Problem

A fixed recent-message window eventually forgets older scene context.

## Goal

Support long roleplay sessions without simply sending unlimited history.

## Design

Maintain:

1. recent raw messages;
2. rolling conversation summary;
3. durable character memory.

## Summary requirements

Summary should preserve:

- current location/scene;
- relationship state;
- unresolved plans;
- recent important events;
- relevant emotional/social state;
- group participation changes.

Do not let summaries become character instructions.

Store summary server-side.

Inject summary in a clearly delimited untrusted context section.

## Token budgeting

Create a prompt budget function.

Budget components:

- system/persona;
- memory;
- summary;
- recent raw history;
- newest user turn;
- generation reserve.

Never let the request unexpectedly exceed llama.cpp context.

---

# 27. TASK QWEN-STAB-006 — More Natural Speaker Director

Only after deterministic group routing is correct.

## Goal

General group chat should not always fall back to the first character.

## Hybrid design

Use deterministic rules first:

- explicit names;
- everyone/both phrases;
- direct question to a known speaker.

For ambiguous turns, optionally ask the local model for a tiny structured decision.

Example output:

```json
{
  "speakers": ["character-id"],
  "reason": "brief internal reason"
}
```

Validate output strictly.

Never permit arbitrary IDs.

Fallback to deterministic safe behavior if director output is invalid.

## Behavior goals

- characters do not all answer every turn;
- a directly addressed character responds;
- multiple speakers respond when natural;
- turn-taking varies naturally;
- no character is starved forever in a long group chat.

Add deterministic tests around the validation layer even if model choice itself is nondeterministic.

---

# 28. TASK QWEN-STAB-007 — Frontend Module Split

## Problem

`public/openparlor/openparlor.js` has grown large.

## Goal

Keep plain browser JavaScript but split responsibilities using native ES modules.

Suggested modules:

- `api.js`
- `chat.js`
- `characters.js`
- `conversations.js`
- `memory.js`
- `audio.js`
- `groups.js`
- `settings.js`
- `ui.js`

Do NOT introduce Vue/React/Svelte for this refactor.

Refactor in small tasks with existing tests kept green.

---

# 29. TASK QWEN-STAB-008 — Browser Acceptance Harness

## Goal

Make real authenticated browser acceptance easier so manual clicking is not required after every task.

Current browser infrastructure may require developer-local storage state.

Create a documented safe local method to create/use authenticated Playwright storage state.

Never commit authentication state.

Automate at least:

- app loads;
- create/select characters;
- create two-character conversation;
- everyone -> both respond;
- explicit Monica -> Monica responds;
- speaker labels correct;
- streamed deltas complete;
- Stop works;
- TTS controls attach to correct speaker;
- no console errors.

---

# 30. TASK QWEN-STAB-009 — Character Card Import/Export

After stabilization.

## Goal

Support common roleplay character cards without coupling OpenParlor to SillyTavern's full UI.

Inspect and reuse mature SillyTavern parsing where safe.

Support:

- import JSON;
- import common PNG metadata;
- export;
- preserve unknown fields when possible;
- map OpenParlor voice/settings separately.

Do not overwrite provider configuration from imported card content.

---

# 31. TASK QWEN-STAB-010 — Personal v0.1 Acceptance

Before declaring personal v0.1 ready, test the entire local stack.

## Text

- one-on-one chat;
- long multi-turn chat;
- reload persistence;
- cancellation.

## Group

- 2 characters;
- 3 characters;
- everyone;
- explicit name;
- multiple explicit names;
- generic turn;
- history speaker identity.

## Memory

- memory generated;
- memory edited;
- memory pinned;
- memory deleted;
- cross-chat recall;
- knowledge privacy for absent character.

## TTS

- correct voice per character;
- manual play;
- stop;
- replay;
- auto-speak;
- sequential group playback.

## STT

- microphone record;
- transcribe;
- edit transcript;
- send;
- voice mode.

## Failure states

- llama.cpp offline;
- Kokoro offline;
- STT unavailable;
- invalid character;
- deleted/archived character;
- aborted generation.

No silent corruption.

---

# 32. Prompt to Give Qwen

After placing this file in the repository, the user should be able to give Qwen only this short instruction:

> Read `OPENPARLOR_QWEN_ONLY_STABILIZATION_PLAN.md` completely. Execute only Phase 0 through TASK QWEN-GROUP-001 for the initial Qwen-only experiment. Do not use Codex. Work autonomously through implementation, tests, corrections, self-review, and local commit. Follow the safety branch and reporting requirements exactly. Stop after committing TASK QWEN-GROUP-001 and report the commit SHA and verification results.

Qwen should not need another routine prompt during that task.

---

# 33. How We Will Judge Qwen

After Qwen stops, evaluate:

### Strong result

Qwen:

- fixes all related group issues;
- tests behavior correctly;
- does not introduce new architecture problems;
- recognizes prompt identity semantics;
- keeps server authority;
- produces a clean focused diff;
- explains the result accurately.

If so, proceed to later stabilization tasks with Qwen as primary developer.

### Partial result

Qwen:

- fixes `everyone`;
- fixes UI label;
- misses prompt/history identity or duplication.

Then Qwen can still be primary implementer, but should receive highly explicit task specifications like this document.

### Weak result

Qwen:

- patches only one symptom;
- breaks tests;
- weakens security;
- duplicates logic;
- cannot converge after three correction rounds.

Then use Qwen as implementation worker and retain a stronger reviewer for architecture/acceptance.

---

# 34. Final Rule

For the initial experiment, success is not measured by how much code Qwen writes.

Success is measured by whether Qwen can correctly understand a cross-layer bug, make a bounded change, prove it with tests, review itself, and stop with a clean commit.

**Execute TASK QWEN-GROUP-001 only, then stop for review.**
