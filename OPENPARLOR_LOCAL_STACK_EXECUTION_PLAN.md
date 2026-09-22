# OpenParlor Personal Local-Stack Execution Plan

## Purpose

This document is the execution specification for making **OpenParlor** usable end-to-end with the local AI stack already installed on this machine.

Codex should treat this as a project plan to execute, not as a discussion document.

The target experience is:

1. Start the existing local AI services.
2. Start OpenParlor.
3. Open OpenParlor in a browser.
4. Create/select a character.
5. Type or speak to the character.
6. The configured local llama.cpp model generates the reply.
7. The reply streams into the UI.
8. OpenParlor can speak the reply with the local TTS service.
9. Characters and conversations persist.
10. Characters retain appropriate memories across conversations.
11. Multi-character conversations work.
12. Everything remains local-first and server-side provider configuration is never exposed to the browser.

The implementation should reuse the existing OpenParlor architecture and the proven Codex-supervisor/Qwen-worker workflow. Do not rewrite the application from scratch.

---

# 1. Codex Operating Contract

## 1.1 Primary operating mode

Codex owns execution from task selection through acceptance.

The user should not be required to act as a message relay between Codex, Qwen/Aider, tests, and runtime checks.

For routine work Codex must:

1. inspect repository state;
2. read this plan and the existing `.agent` state;
3. choose the next dependency-safe task;
4. write/update `.agent/current-task.md`;
5. define an explicit implementation/test file allowlist;
6. launch one bounded local Qwen/Aider worker;
7. monitor the worker PID/PGID;
8. review the diff;
9. run focused validation;
10. diagnose failures;
11. launch a fresh bounded correction worker only when needed;
12. perform semantic review itself;
13. perform real local runtime tests when applicable;
14. stage only accepted task files;
15. commit accepted work locally;
16. update `.agent/handoff.md`;
17. continue automatically only when running in the chosen auto mode.

Do not stop for routine lint/test failures.

Do not ask the user to copy another prompt just because a worker needs a correction pass.

Do not ask the user to manually create a directory/config file that Codex can safely create as a local untracked runtime file.

Only stop for a genuine blocker requiring human knowledge, credentials, policy choice, or physical interaction.

## 1.2 Worker rules

Qwen/Aider is the implementation worker.

The worker must:

- never commit;
- never push;
- never choose the next task;
- never edit supervisor-owned task/handoff files unless explicitly allowed for a documentation-only task;
- only edit the exact allowlisted production/test files;
- receive a bounded, concise task;
- use a fresh model session for each implementation/correction pass;
- preserve existing dirty task work;
- never reset/clean/stash unrelated work.

Codex remains the architect/reviewer/acceptance authority.

## 1.3 Process rules

The supervisor must:

- allow only one launcher-owned implementation worker at a time;
- track launcher-created PID and PGID;
- never kill unrelated Codex/Aider/Cline/llama-server processes;
- confirm the worker and launcher-owned children are gone before starting another pass;
- preserve worktree state after interruption;
- use finite correction rounds;
- never create an infinite retry loop;
- make progress visible with phase banners.

## 1.4 Approval behavior

Normal OpenParlor supervision should not repeatedly stop for command approval.

Keep workspace safeguards, but configure the OpenParlor Codex workflow so routine allowed commands do not require interactive approval.

Do not bypass sandboxing globally merely to avoid prompts.

## 1.5 Git rules

- Qwen never commits or pushes.
- Codex may commit only after acceptance.
- Use explicit-path staging.
- Never include unrelated dirty files.
- Do not automatically push unless the user later explicitly enables automatic pushing.
- Current target branch: `openparlor-main`.
- Existing upstream SillyTavern history must remain intact.

---

# 2. Known Current Environment

Codex must verify these facts at runtime before relying on them. If something changed, update local configuration rather than hardcoding old assumptions.

## 2.1 Repository

Expected repository:

`/home/mark/openparlor`

OpenParlor currently uses SillyTavern as scaffolding while OpenParlor-specific functionality is isolated where practical.

Preferred OpenParlor locations:

- `src/openparlor/`
- `public/openparlor/`
- `tests/openparlor/`
- `.agent/`

Avoid invasive SillyTavern core changes unless integration genuinely requires one.

## 2.2 OpenParlor supervisor

Expected launcher:

`/home/mark/bin/openparlor-codex`

Expected supervisor files include:

- `.agent/CODEX_SUPERVISOR.md`
- `.agent/WORKER_RULES.md`
- `.agent/openparlor-codex`
- `.agent/current-task.md`
- `.agent/handoff.md`
- `.agent/OPENPARLOR_PLAN.md`

Known safe validation mode:

`~/bin/openparlor-codex --resume --check-only`

Normal current-task completion mode:

`~/bin/openparlor-codex --resume`

An autonomous multi-task mode may be implemented as:

`~/bin/openparlor-codex --auto`

but it must remain bounded and stop on genuine blockers.

## 2.3 Local model server

Expected OpenAI-compatible llama.cpp endpoint:

`http://127.0.0.1:8080/v1`

Expected running model currently advertises approximately:

`/home/mark/models/qwen3.8-27b-q6k/Qwen3.8-27B-Q6_K.gguf`

The current llama.cpp server has been run with a 65,536-token context.

Do not hardcode the model identifier into browser JavaScript.

For runtime configuration, obtain the current model identifier from:

`GET http://127.0.0.1:8080/v1/models`

The configured model may be the full GGUF path if that is what llama.cpp advertises.

## 2.4 OpenParlor local runtime config

Expected user-local config path:

`/home/mark/openparlor/data/default-user/openparlor/config.json`

Expected schema:

```json
{
  "model": {
    "provider": "openai-compatible",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "<value returned by /v1/models>"
  },
  "stt": {
    "provider": "",
    "baseUrl": ""
  },
  "tts": {
    "provider": "",
    "baseUrl": "",
    "voice": ""
  }
}
```

This file is local runtime state and must not be committed.

Permissions should remain restrictive, e.g. `0600`.

## 2.5 Existing audio stack to discover and reuse

The machine has existing local audio/AI tooling that OpenParlor should reuse where practical instead of downloading competing stacks unnecessarily.

Known installations/history include:

- Open WebUI;
- local speech-to-text using `large-v3-turbo`;
- Kokoro TTS installation under `~/kokoro`;
- Kokoro has previously exposed a web/API service around port `8880`;
- other TTS experiments may also exist.

Do not guess exact STT/TTS API routes from memory.

Codex must discover what is currently installed/running and use the existing service when it is suitable.

The first preferred TTS target is the existing Kokoro service.

The first preferred STT target is the existing local `large-v3-turbo` setup, but OpenParlor should not become unnecessarily coupled to Open WebUI if the underlying transcription service can be called more directly and cleanly.

---

# 3. Current Foundation That Must Be Preserved

Before continuing, inspect Git history and current worktree.

The project already established these architectural layers:

1. per-user server-side OpenParlor configuration;
2. model-provider abstraction;
3. authenticated OpenParlor chat route;
4. work toward streaming browser integration.

Do not throw these away.

Do not replace the server-controlled provider design with browser-controlled model URLs/API keys.

Provider secrets/endpoints remain server-side.

The browser talks to OpenParlor endpoints only.

---

# 4. Definition of “Working for This Machine”

The personal-ready milestone is complete when all of the following are true.

## 4.1 Text chat

The user can:

- open OpenParlor;
- select/create a character;
- start a one-on-one conversation;
- type a message;
- see the local llama.cpp response stream in real time;
- continue a long conversation;
- reload the page without losing the conversation.

## 4.2 Speech input

The user can:

- click/hold a microphone control;
- record speech in the browser;
- send that audio to OpenParlor;
- have the existing local STT stack transcribe it;
- review/edit the transcription if desired;
- submit the transcription as the user message.

## 4.3 Speech output

The user can:

- assign a local Kokoro voice to a character;
- have OpenParlor request speech from the local TTS service;
- hear assistant replies;
- stop speech immediately;
- optionally disable automatic speech and play messages manually.

## 4.4 Characters

Characters must support at least:

- name;
- avatar;
- description;
- personality;
- scenario;
- greeting;
- system/instruction prompt;
- example dialogue where supported;
- assigned TTS voice;
- optional per-character model overrides later, but not required for first usable version.

Import/export should be compatible with common character-card formats where practical.

## 4.5 Persistence

Persist:

- characters;
- chats;
- messages;
- character settings;
- selected voice;
- conversation membership;
- memory records;
- user preferences.

Use safe, simple local persistence first.

Do not introduce a complex external database merely because it is fashionable.

## 4.6 Memory

A character must be able to remember important facts across separate conversations.

Memory ownership/privacy is character-centric.

Example:

- Emma and Rachel are in a group conversation.
- User tells them a fact.
- Emma may later remember it in a one-on-one conversation.
- Rachel may also remember it.
- Sarah, who was not present and was never told, must not automatically know it.

Memory records therefore need provenance/visibility metadata, not one global shared summary.

## 4.7 Group chat

The user can:

- create a room;
- add multiple characters;
- send one user message;
- have the appropriate character(s) respond;
- avoid every character mechanically answering every turn;
- preserve character identities;
- preserve memory visibility based on who was present.

## 4.8 Local-first behavior

Core personal use must work without paid APIs.

No cloud API should be required for:

- model inference;
- STT;
- TTS;
- characters;
- conversations;
- memory.

---

# 5. Phase 0 — Repository and Runtime Inventory

Codex should execute this phase before adding more features.

## TASK-LOCAL-001 — Establish exact current state

Inspect:

- `git status --short`
- `git log --oneline --decorate -15`
- `.agent/current-task.md`
- `.agent/handoff.md`
- `.agent/OPENPARLOR_PLAN.md`
- `.agent/CODEX_SUPERVISOR.md`
- `.agent/WORKER_RULES.md`
- current diffs under OpenParlor directories.

Acceptance:

- existing in-progress work is identified;
- no work is discarded;
- next task is dependency-safe.

## TASK-LOCAL-002 — Discover local AI services

Run read-only discovery such as:

```bash
pgrep -af 'llama-server|open-webui|kokoro|whisper|faster-whisper|fish|tts'
ss -lntp
```

Probe known local ports without assuming API shape.

Model:

```bash
curl -fsS http://127.0.0.1:8080/v1/models
```

For Kokoro, first inspect the actual process/start script and, if HTTP service is active, probe likely metadata endpoints such as `/openapi.json` only after confirming the port.

For STT, inspect:

- Open WebUI config/startup;
- current process command lines;
- installed transcription packages/services;
- any existing API endpoint already used successfully.

Record discovered runtime interfaces in a local developer document that contains no secrets.

Acceptance:

- exact model endpoint known;
- exact TTS interface known or a clear blocker recorded;
- exact STT interface known or a clear blocker recorded;
- no duplicate audio stack installed yet.

---

# 6. Phase 1 — Finish Reliable Real-Time Text Chat

This is the first hard dependency for everything else.

## TASK-CHAT-001 — Complete current streaming chat task

Finish the existing streaming work rather than starting over.

Server requirements:

- authenticated route;
- per-user config;
- `streamChatCompletion()`;
- SSE or similarly explicit framing;
- explicit completion event;
- safe error event;
- disconnect abort;
- UTF-8-safe parsing;
- no provider secrets in responses.

Browser requirements:

- immediate user bubble;
- assistant bubble created promptly;
- incremental append;
- no full-list rerender per token;
- Enter sends;
- Shift+Enter newline;
- no accidental duplicate generation;
- safe cancellation state.

Acceptance:

- focused lint passes;
- focused Node tests pass;
- real request reaches llama.cpp;
- real generated Qwen text streams into browser;
- disconnect terminates backend generation;
- task committed locally.

## TASK-CHAT-002 — Conversation history sent correctly

The current browser/API must send relevant conversation history, not only the newest line.

Implement a server-controlled message-building layer.

Do not yet mix memory retrieval into this task.

Acceptance:

- multi-turn context works;
- system/user/assistant roles remain valid;
- malformed client roles are rejected/sanitized;
- token growth is bounded.

## TASK-CHAT-003 — Generation cancellation

Add Stop Generation.

Requirements:

- browser uses `AbortController`;
- server sees disconnect/abort;
- provider request aborts;
- UI remains usable afterward.

---

# 7. Phase 2 — Persistence and Conversation Model

## TASK-DATA-001 — Define OpenParlor persistence boundary

Choose the simplest persistence that fits the existing app.

Prefer reusing safe existing SillyTavern storage conventions where doing so reduces risk, while placing OpenParlor-specific data behind OpenParlor APIs.

Do not expose filesystem paths to the browser.

Define entities:

- Character
- Conversation
- ConversationParticipant
- Message
- Memory
- UserOpenParlorSettings

Document IDs, timestamps, ownership, and migration strategy.

## TASK-DATA-002 — Persist one-on-one chats

Requirements:

- create conversation;
- append messages;
- load conversation;
- list recent conversations;
- rename conversation;
- delete/archive conversation;
- preserve timestamps;
- crash-safe writes.

Acceptance:

- restart server;
- reload browser;
- previous chat remains.

## TASK-DATA-003 — Conversation list UI

Replace fake/demo sidebar items with real stored conversations.

Support:

- new chat;
- recent chats;
- active selection;
- title;
- last activity;
- character avatar/name.

---

# 8. Phase 3 — Character System

## TASK-CHAR-001 — Character schema

Define an OpenParlor character schema.

Minimum fields:

- id
- name
- avatar
- description
- personality
- scenario
- firstMessage
- systemPrompt
- exampleDialogue
- tags
- createdAt
- updatedAt
- ttsProvider
- ttsVoice

Keep fields extensible.

## TASK-CHAR-002 — Character CRUD APIs

Authenticated endpoints:

- list
- get
- create
- update
- delete
- clone

Validate all input.

Do not let character content override server provider credentials.

## TASK-CHAR-003 — Character UI

Replace hardcoded Emma/Rachel/Sarah demo state with actual characters.

Support:

- character list;
- avatar;
- create/edit form;
- select character;
- start chat.

Keep UI straightforward.

## TASK-CHAR-004 — Prompt assembly

Implement a server-side prompt builder.

Order should be deterministic and tested.

Typical components:

1. OpenParlor global behavior;
2. character system prompt/persona;
3. scenario;
4. relevant memory;
5. recent conversation history;
6. newest user input.

Do not let browser JavaScript secretly build the authoritative system prompt.

## TASK-CHAR-005 — Character-card import/export

Inspect SillyTavern's current card handling and reuse compatible parsing where practical.

Support common PNG/JSON character cards without unnecessarily reimplementing mature parsing logic.

Preserve unknown metadata on round-trip where possible.

---

# 9. Phase 4 — Model Settings for the Existing llama.cpp Stack

## TASK-MODEL-001 — Settings status panel

Add server-backed settings/status UI.

Show:

- configured provider;
- configured endpoint host in a safe form;
- discovered model(s);
- connection health;
- current selected model;
- context capability if discoverable.

Never send API keys to the browser.

For localhost personal use, endpoint display may be allowed if intentionally exposed by server, but secrets remain hidden.

## TASK-MODEL-002 — Server-side config editing

Add authenticated server API to update permitted OpenParlor config fields.

Requirements:

- atomic write;
- restrictive permissions;
- validation;
- no arbitrary filesystem path writes;
- API key fields write-only if later supported.

This avoids requiring manual shell editing for routine personal use.

## TASK-MODEL-003 — llama.cpp compatibility checks

At connection time:

- probe `/v1/models`;
- validate selected model;
- expose clear status if model server is unavailable;
- do not crash the UI if inference server is offline.

---

# 10. Phase 5 — Kokoro TTS Integration

Use the existing Kokoro installation first.

Do not download a replacement TTS stack until the existing service has been evaluated.

## TASK-TTS-001 — Discover exact Kokoro API

Codex should inspect:

- `~/kokoro`;
- running process command;
- service/start script;
- bound port(s);
- OpenAPI schema if exposed.

Determine:

- speech endpoint;
- voices endpoint;
- request format;
- returned audio format;
- streaming vs non-streaming support;
- health endpoint.

Record the result.

## TASK-TTS-002 — TTS provider abstraction

Implement server-side interface such as:

- `listVoices()`
- `synthesize(text, options)`
- optional `health()`

First provider: Kokoro.

Browser must call OpenParlor, not Kokoro directly.

This keeps local topology hidden and allows later Fish Speech/Qwen-TTS adapters without rewriting UI.

## TASK-TTS-003 — Character voice assignment

Character editor gets a Voice selector populated through OpenParlor.

Persist selected voice per character.

Allow "No voice".

## TASK-TTS-004 — Play assistant messages

Each assistant message gets:

- play;
- stop;
- replay.

Use browser audio controls programmatically rather than exposing the Kokoro server URL.

## TASK-TTS-005 — Auto-speak mode

Conversation setting:

- Off
- Auto-speak new assistant replies

Requirements:

- stop current speech on explicit Stop;
- do not overlap multiple character voices accidentally;
- queue/replace behavior defined;
- prevent speech from continuing after chat switch.

## TASK-TTS-006 — TTS text cleanup

Before synthesis, optionally strip model-only markup that should not be spoken.

Do not mutate displayed message content.

Support a tested speech-text transformation layer.

---

# 11. Phase 6 — Existing Local STT Integration

Use the existing `large-v3-turbo` speech-to-text stack if practical.

## TASK-STT-001 — Discover actual STT interface

Inspect existing Open WebUI/STT configuration and current installed services.

Determine whether the cleanest path is:

A. call an already-running local transcription HTTP endpoint; or
B. create a small OpenParlor server-side adapter around the installed local transcription engine.

Avoid coupling OpenParlor to Open WebUI session/auth internals if a direct local transcription interface is cleaner.

Do not download another large Whisper model before verifying the existing model can be reused.

## TASK-STT-002 — STT provider abstraction

Server-side interface:

- `transcribe(audio, options)`
- optional `health()`
- optional language detection/settings

First provider: discovered local large-v3-turbo stack.

## TASK-STT-003 — Browser microphone recording

Use browser `MediaRecorder`.

Requirements:

- clear permission handling;
- record;
- stop;
- cancel;
- recording indicator;
- maximum duration/size;
- supported audio MIME negotiation.

Audio uploads go only to OpenParlor.

## TASK-STT-004 — Transcription UX

Default safe flow:

1. record;
2. transcribe;
3. place text in composer;
4. user may edit;
5. Send submits.

Later add an optional "send automatically after transcription" preference.

## TASK-STT-005 — End-to-end voice input acceptance

Acceptance:

- speak a sentence;
- local STT transcribes it;
- text appears in composer;
- sending it gets a real Qwen response.

---

# 12. Phase 7 — Full Voice Conversation Loop

## TASK-AUDIO-001 — Voice conversation mode

Add optional conversational mode:

1. user records speech;
2. STT produces text;
3. text is sent;
4. model response streams;
5. response completes;
6. TTS speaks it.

Do not synthesize every partial token.

Default: synthesize after sentence or full-response completion.

## TASK-AUDIO-002 — Latency instrumentation

Record local timings in development mode:

- recording end → STT complete;
- send → first model token;
- model first token → completion;
- completion → TTS audio ready;
- end-to-end turn time.

Do not log private message content just to measure latency.

## TASK-AUDIO-003 — Interruption

If user starts recording while TTS is speaking:

- stop/pause TTS;
- record user naturally;
- avoid overlapping audio.

---

# 13. Phase 8 — Character-Centric Long-Term Memory

This is a key OpenParlor differentiator.

## TASK-MEM-001 — Memory data model

Memory record should include at least:

- id
- text/fact
- type
- importance
- confidence
- createdAt
- updatedAt
- sourceConversationId
- sourceMessageIds
- knownByCharacterIds
- userVisibility/sensitivity metadata if later needed
- supersededBy / active state

Do not use one undifferentiated global memory blob.

## TASK-MEM-002 — Memory extraction

After a conversation turn or bounded batch:

- identify candidate durable facts;
- avoid saving trivial dialogue;
- deduplicate;
- associate only characters who were present/aware;
- keep provenance.

Initially use the same local model for extraction if performance is acceptable.

Memory extraction should be asynchronous relative to UI response when practical.

## TASK-MEM-003 — Memory retrieval

Before generation:

- retrieve memories relevant to current character(s), user message, and conversation;
- filter by `knownBy`;
- cap injected memory;
- rank relevance/importance/recency;
- format as a clear prompt section.

## TASK-MEM-004 — Memory management UI

Allow user to:

- inspect what a character remembers;
- edit;
- delete;
- pin important facts;
- see source conversation when available.

## TASK-MEM-005 — Privacy/knowledge acceptance

Automated scenario:

1. Emma + Rachel hear fact A.
2. Sarah is absent.
3. New chat with Emma → Emma can recall A.
4. New chat with Rachel → Rachel can recall A.
5. New chat with Sarah → A is not injected for Sarah.

---

# 14. Phase 9 — Multi-Character Group Chat

## TASK-GROUP-001 — Conversation participants

Extend persisted conversation model to multiple character IDs.

UI supports adding/removing characters.

## TASK-GROUP-002 — Speaker director

Do not simply ask every character to answer every user message.

Implement a director that chooses:

- no character;
- one character;
- occasionally multiple characters when context warrants.

For initial implementation, the local model can make a structured speaker-selection decision.

Keep it deterministic enough to test.

## TASK-GROUP-003 — Character-specific generation

When Emma speaks:

- use Emma persona;
- use memories Emma knows;
- include relevant group context;
- label/store message as Emma.

Repeat independently for each selected speaker.

## TASK-GROUP-004 — Group TTS

Each character speaks with their assigned voice.

No overlapping audio by default.

Queue character speech in message order.

## TASK-GROUP-005 — Group memory propagation

When a message occurs:

- characters present can become aware of relevant facts;
- absent characters do not automatically inherit them.

Track source speaker/listeners when useful.

---

# 15. Phase 10 — Roleplay Quality Controls

## TASK-RP-001 — Per-character generation style

Add safe generation controls such as:

- temperature;
- top-p/min-p where supported;
- response length preference;
- repetition controls;
- reasoning setting only where model/server supports it.

Store server-side/user settings, not provider secrets in browser.

## TASK-RP-002 — First-person/character consistency

Prompt rules should strongly preserve:

- character identity;
- name;
- relationship;
- current scene;
- current participants.

Do not force every model response through brittle string post-processing.

## TASK-RP-003 — Time-aware roleplay

Add optional current local time/context injection.

Do not fake elapsed time.

For long real-time voice chats, time progression should reflect actual timestamps.

## TASK-RP-004 — Context management

The model currently supports a large context, but OpenParlor must not rely on endlessly resending an entire chat.

Implement:

- recent raw-message window;
- conversation summaries;
- long-term memory;
- token budgeting.

Never let routine chats unexpectedly exceed the server context.

---

# 16. Phase 11 — Settings and Service Health

## TASK-SET-001 — Unified settings page

Sections:

- Model
- Speech to Text
- Text to Speech
- Chat
- Memory
- Audio
- Advanced

## TASK-SET-002 — Health indicators

Show simple state:

- Model: Connected / unavailable
- STT: Connected / unavailable
- TTS: Connected / unavailable

Provide Test buttons.

Do not expose shell internals.

## TASK-SET-003 — Runtime service errors

User-friendly errors:

- model server offline;
- STT offline;
- TTS offline;
- invalid voice;
- request timeout;
- generation canceled.

Log technical details server-side where safe.

---

# 17. Phase 12 — Automated Browser Acceptance

This is necessary so Codex can finish tasks without asking the user to manually click through every change.

## TASK-E2E-001 — Lightweight browser harness

Prefer Playwright if it can be added without turning the frontend into a heavy framework.

Requirements:

- start/use local server;
- authenticate safely in development;
- load `/openparlor/`;
- interact with real DOM;
- capture console/page errors.

Do not weaken production auth for tests.

## TASK-E2E-002 — Text chat acceptance

Automate:

- page load;
- composer;
- send;
- immediate user bubble;
- streamed assistant reply;
- completion;
- duplicate-send prevention;
- Enter;
- Shift+Enter;
- stop generation.

Use a deterministic mocked provider for CI and a real local provider mode for developer acceptance.

## TASK-E2E-003 — Audio acceptance

Where headless browser audio input is practical:

- test upload/transcription endpoint separately;
- test TTS API and browser playback state separately.

Do not block all progress on perfect virtual-microphone automation.

---

# 18. Phase 13 — Security and Local Safety

## TASK-SEC-001 — Server-side provider ownership

Verify across every API:

- browser cannot set arbitrary `baseUrl`;
- browser cannot read API keys;
- browser cannot choose arbitrary filesystem paths;
- character-card text cannot alter server config;
- user-owned paths derive from authenticated context.

## TASK-SEC-002 — Upload limits

Apply limits to:

- character imports;
- avatars;
- recorded audio;
- any future attachments.

## TASK-SEC-003 — HTML/message rendering safety

Model output and character content must not create arbitrary executable HTML/script.

Use safe rendering/sanitization.

## TASK-SEC-004 — Local network exposure

OpenParlor development can bind locally by default.

Do not expose llama.cpp, Kokoro, STT, or OpenParlor broadly to the LAN/Internet without explicit configuration and authentication.

---

# 19. Phase 14 — Performance for the Current Hardware

The current machine is capable but should not waste GPU/VRAM.

## TASK-PERF-001 — Do not duplicate model loads

OpenParlor should consume the already-running llama.cpp server.

Do not spawn a second Qwen instance for normal chat.

## TASK-PERF-002 — Audio service coexistence

Measure real VRAM use for:

- llama.cpp;
- STT;
- Kokoro.

If STT/TTS models are persistent GPU services, ensure their placement does not destabilize the main chat model.

Prefer existing proven GPU placement rather than automatic reallocation until measurements justify changes.

## TASK-PERF-003 — Response latency

Measure:

- first token latency;
- streaming smoothness;
- TTS latency.

Avoid frontend DOM work on every individual token if batching small deltas improves responsiveness.

---

# 20. Phase 15 — Startup and Personal Deployment

## TASK-OPS-001 — Service startup checks

OpenParlor should not silently start every AI service unless intentionally configured to do so.

At startup:

- check model health;
- check STT health;
- check TTS health;
- report status.

Provide optional service-control helpers only if they are safe and match the user's existing setup.

## TASK-OPS-002 — Simple start script

Provide one convenient launcher for personal use, e.g.:

`~/bin/openparlor-start`

It may:

- verify llama.cpp is reachable;
- verify audio services;
- start OpenParlor web server if not running;
- print the browser URL.

Do not kill/restart healthy unrelated services.

## TASK-OPS-003 — Browser URL

The personal local target should be clearly reported, expected around:

`http://127.0.0.1:8000/openparlor/`

If access occurs through SSH from another computer, document the exact safe port-forward command rather than exposing the service publicly.

---

# 21. Phase 16 — Cleanup of SillyTavern Scaffolding

Do this only after OpenParlor's replacement functionality is working.

Do not prematurely delete mature upstream functionality that OpenParlor still depends on.

## TASK-CLEAN-001 — Dependency map

Identify which SillyTavern modules OpenParlor still uses:

- auth;
- users;
- static server;
- character parsing;
- storage;
- tokenizer/provider utilities;
- anything else.

## TASK-CLEAN-002 — Remove unused inherited UI/project automation

Gradually remove dead SillyTavern-specific pieces after proving OpenParlor no longer needs them.

Keep license/attribution obligations intact.

## TASK-CLEAN-003 — Decide backend future

Only revisit a Go backend rewrite after real requirements justify it.

Do not rewrite merely because Go is preferred.

The current priority is a reliable product.

---

# 22. Concrete Dependency Order

Codex should generally follow this sequence unless repository reality reveals a necessary prerequisite:

1. Finish current TASK-004 streaming browser integration.
2. Persist conversations.
3. Replace fake chat list with real conversations.
4. Character schema/API.
5. Character UI.
6. Character prompt assembly.
7. Model settings/health.
8. Discover and integrate Kokoro.
9. Discover and integrate existing large-v3-turbo STT.
10. Full voice conversation loop.
11. Long-term character memory.
12. Memory inspection UI.
13. Multi-character conversation participants.
14. Speaker director.
15. Group TTS.
16. Group-aware memory.
17. Context summarization/token budgeting.
18. Automated browser acceptance.
19. Unified settings/service health.
20. Startup/personal-deployment helpers.
21. Scaffolding cleanup.

Do not start five feature areas in parallel.

Complete vertical slices.

---

# 23. Required Testing Strategy

Every focused task should have the smallest useful verification set.

## Backend unit/focused tests

Use Node's built-in test runner where practical.

Cover:

- validation;
- provider adapters;
- stream framing;
- config boundaries;
- persistence;
- memory visibility;
- character prompt assembly;
- audio adapter request/response behavior.

## Lint

Run focused ESLint for changed JS files.

Do not use `--fix` blindly across the entire inherited repository.

## Integration tests

Use mocked providers for deterministic automated tests.

Use real localhost services for developer acceptance after deterministic tests pass.

## Browser tests

Automate important UX paths.

## Diff checks

Always run:

`git diff --check`

before final acceptance.

---

# 24. Task Acceptance Template

Codex should not mark a task accepted until it can report:

## Scope

- task ID/title;
- exact production files;
- exact test files.

## Verification

- lint command/result;
- focused test command/result;
- integration/runtime result if applicable;
- `git diff --check`.

## Semantic review

- why implementation satisfies the task;
- security/privacy implications;
- no out-of-scope changes.

## Worker state

- no launcher-owned worker remains;
- PID/PGID cleared;
- no stale worker connection remains.

## Commit

- exact staged file list;
- commit SHA;
- worktree status;
- whether commit is pushed.

---

# 25. Human-Only Blockers

Codex should only stop the autonomous flow for something like:

- password/sudo authentication that cannot be avoided;
- browser microphone permission requiring physical user approval;
- a choice between materially different product behaviors not specified here;
- missing hardware/service that is genuinely unavailable;
- credentials to an external service;
- unsafe/unexpected repository state;
- repeated bounded worker failures with no safe automated resolution.

Routine coding/test/configuration work is not a human-only blocker.

---

# 26. Explicit Non-Goals for the First Personal-Ready Release

Do not delay personal usability for:

- cloud account integrations;
- paid APIs;
- mobile app;
- enterprise multi-tenancy;
- Kubernetes;
- microservices;
- a Go rewrite;
- public Internet hosting;
- perfect compatibility with every LLM/STT/TTS provider;
- a plugin marketplace;
- complex vector infrastructure before simple memory retrieval is proven.

Build the user's working local product first.

---

# 27. Final Personal Acceptance Scenario

The personal-ready milestone is complete only when Codex can perform or verify this scenario:

1. llama.cpp is running at `127.0.0.1:8080`.
2. Existing local STT service is available.
3. Existing Kokoro service is available.
4. OpenParlor starts.
5. Browser opens `/openparlor/`.
6. User creates/selects a character named Emma.
7. User assigns one installed Kokoro voice.
8. User starts a new chat.
9. User types: `Remember that my favorite test number is 47.`
10. Qwen response streams normally.
11. TTS can speak the response.
12. User records a second message by microphone.
13. Existing local STT transcribes it.
14. User sends the transcription.
15. Qwen responds.
16. Restart/reload does not lose the conversation.
17. Start a new conversation with Emma.
18. Emma's relevant memory system can retrieve the saved fact when context makes it relevant.
19. Create a group with Emma and Rachel.
20. Tell only Emma and Rachel another fact.
21. Start a separate chat with an absent third character.
22. The third character does not receive that private group-derived memory.
23. Return to Emma; Emma can retrieve it when relevant.
24. All inference, STT, TTS, persistence, and memory remain local.
25. No provider credentials or arbitrary provider endpoints are exposed to browser control.

---

# 28. Instructions to Codex When This File Is Uploaded

When asked to "run this plan":

1. Read this entire document.
2. Read the existing OpenParlor `.agent` files.
3. Inspect repository/worktree/history.
4. Preserve current in-progress work.
5. Convert the next dependency-safe item into the existing OpenParlor task-card format.
6. Use the OpenParlor supervisor and local Qwen/Aider implementation worker.
7. Work autonomously through routine implementation/test/correction cycles.
8. Commit accepted tasks locally.
9. Update `.agent/handoff.md` after each accepted task.
10. Continue according to supervisor mode.
11. Do not ask the user to act as a prompt relay.
12. Stop only on a genuine human-only blocker.

If the current repository already implements part of this plan, verify it and mark it complete rather than rebuilding it.

The plan is an execution guide, not permission to discard existing architecture.

