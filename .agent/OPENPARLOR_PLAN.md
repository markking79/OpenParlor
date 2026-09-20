# OpenParlor Development Plan

## 1. Mission

OpenParlor is a local-first, open-source AI character chat application initially built on top of SillyTavern.

The immediate goal is not to rewrite SillyTavern.

The immediate goal is to:

1. Build a substantially cleaner OpenParlor interface.
2. Make OpenParlor work with the developer's existing local LLM, STT, and TTS setup.
3. Preserve useful SillyTavern functionality and compatibility.
4. Isolate OpenParlor code from SillyTavern code whenever practical.
5. Gradually replace SillyTavern internals only when there is a concrete architectural or performance reason.
6. Eventually make multi-character conversations, persistent character memory, and cross-conversation relationships first-class OpenParlor features.

---

# 2. Development Roles

## Codex: Supervisor

Codex owns:

* architecture
* task selection
* code review
* repository inspection
* acceptance criteria
* test strategy
* integration decisions
* identifying upstream SillyTavern functionality worth reusing
* deciding whether existing SillyTavern code should be wrapped, reused, or replaced
* rejecting poor worker implementations
* keeping the repository clean
* commits after acceptance

Codex should avoid doing routine implementation work itself when Qwen can reasonably perform it.

Codex may make very small corrections directly when that is more efficient than another worker round, but substantial implementation should be delegated to Qwen.

## Qwen: Programmer

Qwen owns routine implementation:

* HTML
* CSS
* JavaScript
* Node.js
* API adapters
* provider implementations
* tests
* refactors explicitly requested by Codex

Qwen does not decide project architecture.

Qwen works from narrowly scoped task cards produced by Codex.

---

# 3. Repository Rules

OpenParlor currently tracks:

```text
origin
    markking79/OpenParlor

upstream
    SillyTavern/SillyTavern
```

Development branch:

```text
openparlor-main
```

SillyTavern upstream branch:

```text
upstream/release
```

OpenParlor pushes only to `origin`.

Never push OpenParlor development to the SillyTavern repository.

Upstream SillyTavern changes are reviewed individually. Do not blindly merge upstream releases.

---

# 4. Most Important Architectural Rule

Prefer OpenParlor-specific code.

Target structure:

```text
public/
    openparlor/
        index.html
        css/
        js/
        assets/

src/
    openparlor/
        config/
        providers/
            model/
            stt/
            tts/
        chat/
        characters/
        memory/
        conversations/
```

Existing SillyTavern files should not be modified unless integration genuinely requires it.

If an existing SillyTavern function can be wrapped rather than modified, wrap it.

Bad:

```text
OpenParlor logic scattered through 40 SillyTavern files
```

Good:

```text
OpenParlor
    ↓
OpenParlor adapter
    ↓
existing SillyTavern functionality
```

This separation is important because it lets OpenParlor:

* continue receiving selected upstream fixes
* replace SillyTavern subsystems later
* potentially move portions of the backend to Go later
* remain maintainable as an independent project

---

# 5. Current State

The untouched SillyTavern 1.19.0 baseline has been verified working.

Environment currently verified:

```text
Node v22.23.2
npm 12.0.2
SillyTavern 1.19.0
branch: openparlor-main
```

Server:

```text
http://127.0.0.1:8000/
```

Original SillyTavern interface remains at:

```text
/
```

The initial OpenParlor UI prototype lives at:

```text
/openparlor/
```

The original SillyTavern interface should remain available during early development for comparison and debugging.

---

# 6. Development Philosophy

Build vertical slices.

Do not spend weeks implementing infrastructure before something works end-to-end.

Preferred cycle:

```text
UI
 ↓
OpenParlor adapter
 ↓
working backend capability
 ↓
real local model
 ↓
acceptance test
```

Every significant feature should become usable before moving to the next major feature.

---

# 7. Provider Architecture

The browser must not directly depend on a specific local service.

Never scatter calls such as:

```javascript
fetch("http://127.0.0.1:8080/v1/...")
```

through the UI.

Instead expose generic OpenParlor capabilities.

Conceptually:

```javascript
OpenParlor.chat.send(...)
OpenParlor.chat.stop(...)

OpenParlor.models.list(...)

OpenParlor.audio.transcribe(...)
OpenParlor.audio.speak(...)
```

Backend/provider layer:

```text
OpenParlor

ModelProvider
├── OpenAICompatible
├── future Ollama
├── future OpenRouter
└── future others

STTProvider
├── developer's current local STT
├── future Whisper/OpenAI-compatible
└── future others

TTSProvider
├── developer's current local TTS
├── future Kokoro
├── future Fish Speech
└── future others
```

The developer's setup is the first supported configuration, not a hard-coded product assumption.

---

# 8. Configuration

Machine-specific values must not be committed.

Use a local OpenParlor configuration location, preferably inside the existing SillyTavern data directory or another ignored runtime-data location.

Conceptual schema:

```json
{
  "model": {
    "provider": "openai-compatible",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "..."
  },
  "stt": {
    "provider": "...",
    "baseUrl": "..."
  },
  "tts": {
    "provider": "...",
    "baseUrl": "...",
    "voice": "..."
  }
}
```

Repository may contain:

```text
openparlor-config.example.json
```

Repository must not contain private/local configuration values or secrets.

Eventually the OpenParlor Settings UI will edit this same configuration system.

Do not build a large settings interface yet.

---

# 9. Supervisor Execution Loop

For every task Codex must follow this process.

## A. Inspect state

Before selecting work:

```bash
git status --short
git log --oneline -10
```

Read:

```text
.agent/OPENPARLOR_PLAN.md
.agent/current-task.md
.agent/handoff.md
```

Inspect relevant source before creating a task.

## B. Select one dependency-first task

Do not work on several unrelated features simultaneously.

Select the smallest task that moves the current milestone forward.

## C. Write `.agent/current-task.md`

It must include:

```text
Task ID
Title
Goal
Why this task exists
Relevant existing files
Allowed files to modify
Files that should not be modified
Implementation requirements
Acceptance criteria
Tests/checks required
Out of scope
```

## D. Delegate to Qwen

Give Qwen the complete task card plus relevant architectural constraints.

Qwen should inspect relevant files before editing.

Qwen must not broaden scope without Codex approval.

## E. Review Qwen's work

Codex must inspect:

```bash
git status --short
git diff --stat
git diff
```

Review for:

* correctness
* unintended modifications
* duplicated functionality
* architectural violations
* hard-coded local values
* security problems
* unnecessary SillyTavern core modifications
* regressions
* poor error handling
* performance problems

## F. Run acceptance checks

Depending on task:

```bash
npm run lint
```

and relevant tests/build checks.

Also perform targeted runtime checks where appropriate.

## G. Reject or accept

If work is wrong:

* explain specific defects
* send Qwen a correction task
* review again

Do not accept work merely because it runs.

## H. Commit

Only after acceptance.

One logical task per commit whenever practical.

Commit style:

```text
TASK-001 add OpenParlor model provider abstraction
TASK-002 stream model responses into chat UI
TASK-003 add OpenParlor TTS provider
```

## I. Update handoff

`.agent/handoff.md` should contain:

```text
Current state
Last completed task
Important decisions
Known issues
Next dependency-first task
Relevant commands
Anything the next Codex session must know
```

---

# 10. Initial Roadmap

## Phase 0 — Baseline and Supervisor Infrastructure

### TASK-001 — Establish OpenParlor agent files

Create:

```text
.agent/OPENPARLOR_PLAN.md
.agent/current-task.md
.agent/handoff.md
```

Do not alter application behavior.

Acceptance:

* project plan committed
* current state documented
* supervisor has durable repository context

---

## Phase 1 — First Real Model Conversation

Goal:

```text
OpenParlor UI
    ↓
OpenParlor backend endpoint
    ↓
provider abstraction
    ↓
local llama.cpp/OpenAI-compatible server
    ↓
stream response
    ↓
OpenParlor UI
```

### TASK-002 — OpenParlor configuration loader

Implement machine-local configuration handling.

Requirements:

* no local endpoints hard-coded into frontend
* safe default/error behavior
* config excluded from Git where appropriate
* example configuration documented

Do not build settings UI yet.

### TASK-003 — Model provider interface

Create generic model provider abstraction.

Initial implementation:

```text
OpenAICompatibleModelProvider
```

Capabilities:

```text
listModels()
chatCompletion()
streamChatCompletion()
cancelGeneration()
```

The provider must not assume Qwen specifically.

### TASK-004 — OpenParlor backend chat endpoint

Expose an OpenParlor-specific endpoint used by the OpenParlor UI.

Conceptually:

```text
POST /api/openparlor/chat
```

It should call the configured model provider.

Do not directly expose private/local service URLs to browser code unnecessarily.

### TASK-005 — Streaming chat UI

Replace demo response behavior with real streamed responses.

Acceptance scenario:

```text
User opens /openparlor/
User types "Hello"
User presses Send
Configured local model receives request
Response streams into a new AI message
Generation completes without refreshing page
```

Support cancellation if easy within this task; otherwise make cancellation the next task.

### TASK-006 — Stop generation

Add Stop behavior.

UI:

```text
Send → Stop while generating
```

Generation must actually be aborted server-side/provider-side where possible.

---

# 11. Phase 2 — TTS

Goal:

```text
AI response
    ↓
OpenParlor TTS provider
    ↓
developer's local TTS
    ↓
browser playback
```

### TASK-007 — TTS provider abstraction

Create generic interface.

Conceptual operations:

```text
synthesize(text, voice, options)
listVoices()
```

Implement developer's current TTS system first.

Do not hard-code implementation into character/chat UI.

### TASK-008 — Message speech playback

Each assistant/character response can be spoken.

Initial UI may have:

```text
🔊
```

on messages.

Acceptance:

* button sends message text to TTS provider
* returned audio plays in browser
* playback can be stopped

### TASK-009 — Character voice field

Allow a character to reference a configured voice.

Do not create a complete character editor yet.

---

# 12. Phase 3 — Speech to Text

Goal:

```text
microphone
    ↓
browser recording
    ↓
OpenParlor backend
    ↓
STT provider
    ↓
text
    ↓
composer
```

### TASK-010 — STT provider abstraction

Generic operation:

```text
transcribe(audio)
```

Implement developer's existing STT service first.

### TASK-011 — Browser microphone capture

Add microphone button near composer.

Initial behavior:

```text
press microphone
record
stop
transcribe
place text into composer
```

Do not auto-send by default initially.

This lets the user correct transcription errors.

---

# 13. Phase 4 — Minimal Model and Audio Settings

Only after model, TTS and STT work.

Create a small Settings screen for:

```text
Model provider
Model URL
Model
STT provider
STT URL
TTS provider
TTS URL
Voice
```

This UI edits the existing configuration system.

It must not introduce a second settings architecture.

---

# 14. Phase 5 — Character Compatibility

Goal:

Use real SillyTavern characters from OpenParlor.

### TASK-012 — Character adapter

Create OpenParlor character representation.

OpenParlor should access characters through an adapter rather than directly coupling all UI code to SillyTavern internals.

Example conceptual interface:

```javascript
characters.list()
characters.get(id)
characters.create(...)
characters.update(...)
characters.import(...)
```

### TASK-013 — Character library

Replace fake Emma/Rachel/Sarah right-sidebar data with real characters.

Requirements:

* avatar
* name
* basic metadata
* efficient loading
* no full character payloads unnecessarily loaded for every item

### TASK-014 — Single-character conversation

Choose a character and have a real conversation using that character's existing SillyTavern prompt/card data.

This is a major milestone.

---

# 15. Phase 6 — Character Creation

Improve on SillyTavern's UX rather than merely copying it.

Support:

```text
Create manually
Create with AI
Import character card
```

Manual creation should initially expose only important fields.

Advanced fields may live under an Advanced section.

AI-assisted creation should accept natural language such as:

```text
A 40-year-old veterinarian who is funny, independent,
recently divorced and loves hiking.
```

The model may suggest:

```text
description
personality
scenario
background
example dialogue
first message
```

User reviews before saving.

Maintain compatibility with common SillyTavern character card formats where practical.

---

# 16. Phase 7 — Multi-Character Conversations

This is a defining OpenParlor feature.

Conversation model:

```text
Conversation
├── User
├── Character A
├── Character B
└── Character C
```

OpenParlor should make participants explicit.

### Required functionality

```text
create group conversation
add character
remove character
manually address character
let one character respond
let multiple characters respond
stop generation
```

Do not initially build an overly complicated speaker director.

Start deterministic and understandable.

---

# 17. Phase 8 — Speaker Director

Introduce orchestration separately from basic group chat.

Conceptual result:

```json
{
  "nextSpeaker": "emma",
  "continueConversation": true
}
```

Potential modes:

```text
Manual
Mention-based
Round-robin
Automatic director
```

The user should be able to control behavior.

---

# 18. Phase 9 — Cross-Conversation Character Memory

This is another defining feature.

Memory should belong primarily to characters rather than only conversations.

Example:

```text
Group:
User tells Emma, Rachel and Sarah about a job interview.

Later:
Private conversation with Emma.

Emma can remember the job interview.
```

But:

```text
Private:
User tells Emma they may reject the job.

Rachel and Sarah should not automatically know that.
```

Memory data should therefore record knowledge ownership.

Conceptual model:

```text
Memory
├── content
├── sourceConversation
├── sourceMessage
├── createdAt
├── importance
└── knownBy[]
```

Memory layers:

```text
core identity
relationship memory
shared/group memories
private memories
recent raw messages
older conversation summaries
```

Do not implement this until ordinary single and group conversations are stable.

---

# 19. Phase 10 — Performance and Storage

OpenParlor should be intentionally designed for long-lived use.

Rules:

* do not render thousands of messages at once
* paginate older messages
* avoid loading entire histories when opening sidebar lists
* lazy-load avatars/media
* batch streaming UI updates
* keep chat summaries separate from chat contents
* profile before rewriting infrastructure

Potential future storage:

```text
SQLite
```

Potential eventual entities:

```text
characters
conversations
conversation_participants
messages
memories
relationships
lorebooks
```

Do not migrate storage simply because SQLite seems cleaner.

Migrate only after OpenParlor is functional enough to define the required schema correctly.

---

# 20. Go Policy

Do not rewrite the backend in Go at this stage.

Go remains an architectural option, not a requirement.

If OpenParlor's abstraction boundaries are good, a future migration could look like:

```text
OpenParlor UI
      ↓
OpenParlor API
      ↓
Go backend
      ↓
SQLite
```

without rewriting the UI.

A Go rewrite requires evidence that it improves:

```text
performance
deployment
maintainability
storage architecture
concurrency
```

Do not rewrite working SillyTavern functionality merely for language preference.

---

# 21. SillyTavern Upstream Policy

Never blindly merge upstream.

Periodically inspect:

```bash
git fetch upstream
git log openparlor-main..upstream/release --oneline
```

Candidate upstream changes:

```text
security fixes                 take seriously
provider/API compatibility     likely useful
character-card compatibility   likely useful
tokenizer/prompt fixes         likely useful
backend correctness fixes      review
SillyTavern UI changes         usually irrelevant
styling changes                usually irrelevant
features already replaced      ignore unless needed
```

Prefer cherry-picking or carefully merging useful changes over automatic synchronization once OpenParlor begins diverging substantially.

---

# 22. Qwen Worker Rules

Every Qwen task must state:

```text
You are the implementation worker.
Do not redesign architecture.
Do not broaden scope.
Do not commit.
Do not push.
Inspect relevant existing files before editing.
Preserve existing behavior outside this task.
Prefer OpenParlor-specific files.
Do not modify SillyTavern core unless the task explicitly permits it.
Run requested tests/checks.
At completion report:
- files changed
- implementation summary
- tests/checks run
- known concerns
```

Qwen must not select the next task.

Codex selects the next task after reviewing the current work.

---

# 23. Codex Acceptance Rules

A task is complete only when Codex confirms:

```text
implementation matches task
architecture remains clean
no unrelated modifications
no machine-specific values committed
tests/checks pass
runtime behavior is sensible
diff has been reviewed
handoff is updated
```

Do not accept implementations solely because tests pass.

---

# 24. Near-Term Milestone

The first meaningful OpenParlor milestone is:

```text
Open /openparlor/

Choose/configure local Qwen model

Type a message

Receive streaming AI response

Press mic
```
