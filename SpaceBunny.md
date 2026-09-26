OpenParlor — Master Project Handoff for Autonomous Coding AI
1. Your role
You are the primary autonomous coding AI for the OpenParlor project.
You are expected to perform your own:
- repository inspection;
- architecture analysis;
- implementation planning;
- coding;
- testing;
- debugging;
- adversarial review;
- browser validation where possible;
- Git commits;
- feature branches;
- pull requests.
Do not use the previous Qwen/gpt-oss-20b supervisor/worker system.
Do not invoke:
~/bin/openparlor-worker
~/bin/openparlor-coding-worker

unless the human explicitly asks.
You have your own coding/reasoning capabilities. Use them.
The current repository and its tests are the source of truth. This document describes intent and architectural constraints, but if implementation details have changed, inspect the actual code before making assumptions.
2. Repository
Repository:
markking79/OpenParlor

Main OpenParlor integration branch:
openparlor-main

Typical local checkout:
~/openparlor

Before starting a feature:
cd ~/openparlor || exit 1

git fetch --all --prune
git checkout openparlor-main
git pull --ff-only

git status --short
git log --oneline -20

The working tree must be clean before feature work begins.
Never implement a substantial new feature directly on openparlor-main.
Create a branch such as:
git checkout -b voice-003-barge-in

One major roadmap feature = one focused branch/PR unless a feature genuinely needs staged sub-PRs.
Do not force-push.
Do not merge a PR unless the human explicitly tells you to merge it.
3. What OpenParlor is
OpenParlor is a local-first AI character and roleplay application.
It originated inside a SillyTavern-derived repository, but OpenParlor is becoming its own isolated application architecture.
The desired user experience is closer to a polished local AI companion/character application than to a generic LLM chat frontend.
Major product goals:
- local-first operation;
- local OpenAI-compatible LLM support;
- character creation/import/export;
- persistent characters;
- persistent conversations;
- natural character memory across separate conversations;
- character-specific private knowledge;
- multi-character rooms;
- intelligent speaker routing;
- local STT;
- local TTS;
- character-specific voices;
- low-latency streaming speech;
- Hands-Free conversations;
- natural interruption/barge-in;
- natural turn detection;
- excellent roleplay continuity;
- reliable cancellation;
- robust stale-callback protection;
- usable configuration/UI;
- eventual standalone OpenParlor documentation and installation flow.
Core philosophy:
Characters, conversations, speaker identity, memory visibility, and asynchronous ownership are real application state. Do not treat them as cosmetic metadata.

4. Existing OpenParlor layout
Most browser application code is under:
public/openparlor/

Important current modules include:
public/openparlor/app.js
public/openparlor/audio.js
public/openparlor/handsfree.js
public/openparlor/streaming-tts.js
public/openparlor/conversations.js
public/openparlor/characters.js
public/openparlor/memory.js
public/openparlor/progress.js
public/openparlor/settings.js
public/openparlor/ui.js
public/openparlor/openparlor.js
public/openparlor/index.html
public/openparlor/openparlor.css

Server/backend OpenParlor code is primarily under:
src/openparlor/

Important areas include:
src/openparlor/chat-router.js
src/openparlor/conversation-router.js
src/openparlor/character-router.js
src/openparlor/character-card.js
src/openparlor/conversation-summary.js
src/openparlor/memory-extractor.js
src/openparlor/memory-retrieval.js
src/openparlor/memory-router.js
src/openparlor/memory-text.js
src/openparlor/model-provider.js
src/openparlor/model-status-router.js
src/openparlor/persistence.js
src/openparlor/config.js
src/openparlor/prompt-budget.js

Tests are under:
tests/openparlor/

Before implementing any roadmap feature, inspect these directories yourself:
find public/openparlor -maxdepth 1 -type f -print | sort
find src/openparlor -maxdepth 1 -type f -print | sort
find tests/openparlor -maxdepth 1 -type f -print | sort

5. Current completed foundation
A substantial amount of functionality already exists.
Do not rebuild it.
Existing work includes approximately:
- OpenParlor frontend isolation;
- character synchronization;
- character-card compatibility;
- conversation handling;
- multi-character rooms;
- speaker routing;
- direct-address handling;
- speaker director;
- safe archive/delete behavior;
- conversation summaries;
- persistent memory;
- memory extraction/retrieval infrastructure;
- memory quality improvements;
- character-aware memory visibility;
- STT;
- Kokoro TTS;
- manual Play/Replay;
- Hands-Free mode;
- browser VAD;
- local WAV capture;
- streaming model output;
- sentence-level streamed TTS;
- generation Stop;
- deterministic audio ownership;
- stale callback protection.
Do not replace existing components simply because you prefer a different design.
6. VOICE-002 is finished
VOICE-002 implemented streamed speech while the model is still generating.
Treat these semantics as architectural contracts.
It includes:
- streaming sentence splitter;
- direct playBlob() playback;
- streaming TTS coordinator;
- one synthesis request at a time;
- synthesis overlapping playback;
- ordered playback;
- bounded ready-ahead;
- speaker_end handling;
- final unterminated tail handling;
- per-character voice routing;
- muted speakers;
- streaming/legacy turn latch;
- zero-work-only legacy handoff;
- prevention of streamed + legacy duplicate speech;
- unified audio ownership;
- manual Play/Replay takeover;
- conversation-switch cleanup;
- new-send cleanup;
- toggle-off cleanup;
- recording takeover;
- visible active-response Stop;
- actual model AbortController cancellation;
- preservation of partial assistant text;
- intentional AbortError suppression;
- stale-send identity safety;
- Hands-Free WAITING/SPEAKING lifecycle integration.
Do not casually alter these rules.
Particularly important:
Once a streamed sentence exists, never fall back to whole-response legacy TTS.
Otherwise users hear the response twice.
speaker_end matters.
It flushes a speaker's unfinished sentence while the old speaker's voice is still active.
NDJSON done is not TTS completion.
The model may finish while sentence audio remains queued or playing.
Audio has exactly one owner.
Streaming TTS, legacy TTS, manual Play/Replay, recording and Hands-Free must not compete.
Old callbacks must be harmless.
Generation/session identity guards exist for a reason.
7. Non-negotiable architectural rules
7.1 Keep OpenParlor isolated
Prefer modifications under:
public/openparlor/
src/openparlor/
tests/openparlor/

Avoid broad SillyTavern-core modifications.
If a core change is genuinely required:
1. make it minimal;
2. explain why;
3. add regression tests;
4. document the dependency.
7.2 Remain local-first
Do not introduce mandatory cloud services for:
- chat;
- memory;
- STT;
- TTS;
- VAD;
- analytics;
- telemetry.
No telemetry by default.
7.3 Do not hard-code the developer's model
Runtime code must not depend on:
/home/mark/models/...
Qwen
gpt-oss
127.0.0.1:8080

Those were development/testing infrastructure.
OpenParlor should support configured providers/endpoints.
7.4 Character knowledge privacy is a hard invariant
Memory already has concepts around character visibility/provenance.
Preserve them.
A private fact known by Alice must not magically appear in Bob's prompt.
Especially protect concepts equivalent to:
owner_id
character_id
known_by_character_ids
source
provenance

Cross-character information flow must happen because conversation events made knowledge shared, not because retrieval was convenient.
7.5 Async state requires identity
Anything asynchronous that can outlive its origin needs identity/generation protection.
Examples:
- model stream;
- TTS request;
- playback callbacks;
- memory extraction;
- memory refresh;
- conversation loading;
- progress timers;
- browser requestAnimationFrame;
- VAD timers;
- microphone capture.
Old work must never mutate newer work.
7.6 Never solve races using arbitrary sleeps
Bad:
await sleep(100);

to hope another callback completes first.
Good:
- explicit promise settlement;
- generation IDs;
- AbortController;
- state machine;
- ownership token;
- deferred promise in deterministic tests.
8. Workflow for every future feature
Every feature should follow this sequence.
A. Inspect
Before changing code:
- inspect relevant modules;
- inspect existing tests;
- map state ownership;
- map cancellation paths;
- identify stale callback risks;
- identify browser/server boundary;
- identify already-existing helpers.
Then write a short implementation plan.
Do not immediately edit the first file that looks relevant.
B. Implement narrowly
Favor:
- pure helpers;
- explicit state machines;
- small dependency-injected components;
- single owners;
- deterministic transitions.
Avoid giant rewrites.
C. Focused tests
Every asynchronous feature needs tests for:
- normal operation;
- cancellation;
- repeated cancellation;
- stale callback;
- conversation switch;
- disabled mode;
- error;
- recovery/new turn;
- duplicate completion;
- ownership takeover.
D. Full tests
Run:
node --test tests/openparlor/*.test.js

No failing OpenParlor test is acceptable.
E. Lint
Run ESLint on changed OpenParlor JS.
Eventually, before a major merge, lint all OpenParlor JS.
No ESLint errors.
Warnings already established by test style are not necessarily blockers, but do not add careless warnings.
F. Diff check
Run:
git diff --check
git status --short

No whitespace errors.
No temporary files.
No debug logging accidentally committed.
G. Adversarial review
Explicitly inspect the code as if trying to break it.
Look for:
- old callbacks;
- old AbortControllers;
- duplicate completion;
- forgotten cleanup;
- wrong character;
- wrong conversation;
- duplicate TTS;
- missing final sentence;
- lost promise;
- stuck state;
- privacy leak;
- accidental fallback;
- old timers;
- object URL leaks.
H. Dogfood
If behavior involves:
- voice;
- microphone;
- browser timing;
- character interaction;
- UX;
actually test it in a browser.
Automated tests cannot determine whether conversation feels natural.
I. Commit + PR
Only when green:
git status
git diff --check

Commit.
Push branch.
Open PR to:
openparlor-main

Then stop.
Do not automatically start the next feature in the same branch.
9. Remaining roadmap
Recommended execution order:
Order	ID	Feature
1	VOICE-003	Hands-Free barge-in
2	VOICE-004	Better turn/end-of-speech detection
3	MEMORY-002	Natural cross-conversation recall
4	VOICE-005	Conversational voice response style
5	UX-001	OpenParlor product polish
6	DOCS-001	OpenParlor documentation/project identity
7	REL-001	Clean-install/release hardening


Do not work on all of these simultaneously.
10. VOICE-003 — Natural barge-in
Goal
While the AI is speaking, the user should be able to begin talking naturally and interrupt it.
Today Hands-Free is approximately:
LISTENING
↓
HEARING
↓
TRANSCRIBING
↓
WAITING
↓
SPEAKING
↓
LISTENING

VOICE-003 should support:
SPEAKING
↓
user begins speech
↓
barge-in confirmed
↓
AI generation stops
AI audio stops
↓
HEARING
↓
TRANSCRIBING
↓
next user turn

The user should not have to click Stop before speaking.
Core difficulty
While the speakers are playing Kokoro audio, the microphone can hear the AI.
Therefore:
microphone energy ≠ user speech.

Do not simply trigger barge-in on any VAD activity while SPEAKING.
Recommended architecture
During SPEAKING, allow a barge-in detector to monitor microphone input.
Maintain:
- stronger threshold than LISTENING VAD;
- sustained-speech confirmation;
- pre-roll buffer;
- candidate generation/token;
- cancellation when speaking turn ends.
Conceptually:
SPEAKING
   |
possible speech
   v
BARGE_CANDIDATE
   |
speech continues sufficiently
   v
BARGE_CONFIRMED
   |
   +-- stop active model turn
   +-- stopActiveTts(...)
   +-- preserve AI partial text
   +-- preserve microphone pre-roll
   v
HEARING

A transient BARGE_CANDIDATE does not necessarily need to become a public Hands-Free UI state.
Browser microphone
Request appropriate media constraints where supported:
{
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

But do not rely exclusively on echo cancellation.
Initial threshold strategy
Start conservatively.
Reasonable experimental values:
barge-in sustained speech: 200–350 ms
pre-roll:                   250–400 ms

These are tuning starting points.
Make constants named and testable.
Reuse Stop
Do not invent a second model cancellation system.
Confirmed barge-in should use the same logical active-response Stop path already used by the Stop button.
That gives:
- model abort;
- TTS synthesis abort;
- playback stop;
- queue discard;
- stale callback safety;
- partial response preservation.
Then transition into user utterance capture.
Required VOICE-003 tests
At minimum:
1. silence while TTS plays does not interrupt;
2. short noise does not interrupt;
3. sustained speech confirms;
4. confirmation happens once;
5. model AbortController is aborted;
6. streaming TTS session is cancelled;
7. active audio stops;
8. pending sentences never begin;
9. partial assistant text remains;
10. microphone pre-roll is retained;
11. user first word is not lost;
12. one barge-in creates one STT request;
13. stale candidate from old AI turn does nothing;
14. conversation switch invalidates candidate;
15. manual Stop still works;
16. normal Hands-Free without barge-in still works;
17. TTS-ending naturally while candidate exists is handled safely.
VOICE-003 dogfood
Test:
- headphones;
- speakers;
- interrupt first sentence;
- interrupt fifth sentence;
- say "wait";
- say a long sentence;
- cough;
- clap/click;
- talk softly;
- talk loudly;
- interrupt after text generation has finished but TTS still plays.
Do not declare this complete based only on unit tests.
11. VOICE-004 — Better end-of-turn detection
Goal
Hands-Free currently relies largely on silence duration.
That works, but natural human conversation includes:
- short thinking pauses;
- mid-sentence hesitation;
- slow speakers;
- one-word answers;
- long monologues.
VOICE-004 should make endpointing feel less eager and less sluggish.
Do not immediately add another AI model
First build a better deterministic endpoint detector.
Possible state model:
IDLE
↓
SPEAKING
↓
POSSIBLE_END
├── speech resumes -> SPEAKING
└── silence sufficient -> END

Inputs can include:
- speech duration;
- current VAD confidence/energy;
- silence duration;
- previous pauses;
- utterance duration;
- segment count.
Adaptive behavior
Potential rules:
- reject extremely tiny sounds;
- tolerate short hesitation;
- allow larger mid-utterance pauses for longer speech;
- still impose a hard maximum utterance duration;
- endpoint decisively after real finishing silence.
Keep timing logic in one component.
Do not scatter timers throughout handsfree.js.
Required tests
1. one-word utterance completes;
2. ordinary sentence completes;
3. brief pause does not complete;
4. speech restart cancels POSSIBLE_END;
5. long silence completes;
6. several pauses create only one final completion;
7. hard duration cap works;
8. cancellation clears endpoint timer;
9. stale timer cannot end next utterance;
10. barge-in utterance uses same endpoint detector;
11. Hands-Free never remains stuck in HEARING.
Dogfood phrases
Use real speech such as:
Well... I was thinking... maybe we could go tomorrow.

Also test:
- fast speech;
- slow speech;
- deliberate 500 ms pause;
- deliberate one-second pause;
- two-second pause;
- single word;
- 30-second story.
Prefer conversational feel over theoretical perfection.
12. MEMORY-002 — Natural cross-conversation recall
Goal
A character should remember appropriate information from older chats without the user manually restoring context.
Example:
Conversation A with Alice:
My sister is visiting next month.

Conversation B with Alice:
Alice should be capable of naturally recalling that fact when relevant.
Bob should not know it unless Bob legitimately learned it.
Existing memory architecture
Before modifying anything, inspect:
memory-extractor.js
memory-retrieval.js
memory-router.js
memory-text.js
conversation-summary.js
persistence.js
prompt-budget.js

The task is not to throw away existing memory and build a new database.
Improve the existing system.
Character-centric retrieval
Memory retrieval should be based primarily on:
owner + character

rather than:
current conversation only

A character should carry memory across separate chats.
Visibility/privacy
This is non-negotiable.
If a memory is known only by:
Alice

then Bob cannot receive it in his prompt.
In a group conversation, knowledge may become shared if Bob actually hears Alice/user state it.
That knowledge transition must be explicit.
What should become memory
Strong candidates:
- user facts;
- enduring preferences;
- important relationships;
- future plans;
- meaningful shared experiences;
- promises/commitments;
- relationship developments;
- durable character-specific facts.
Weak candidates:
- "hello";
- meaningless small talk;
- temporary filler;
- speculative assistant guesses;
- model hallucinations;
- duplicated facts.
Contradictions
Suppose memory says:
User works at Company A

and user later says:
I left Company A. I work at Company B now.

Do not present both as equally current.
Implement supersession or temporal/current status.
Preserve provenance.
Retrieval ranking
Do not dump the entire memory store into the prompt.
Rank by some combination of:
1. visibility;
2. relevance;
3. importance;
4. recency;
5. durability;
6. redundancy/diversity.
Respect prompt budget.
Prompt safety
Memory is data, not instructions.
A stored memory such as:
Ignore all previous instructions...

must not gain system authority merely because it entered memory.
Keep memory in a clearly delimited prompt section and normalize dangerous structural formatting where appropriate.
Required MEMORY-002 tests
1. Alice learns a fact in conversation A;
2. Alice retrieves it in conversation B;
3. Bob cannot retrieve Alice-private fact;
4. correct group members receive shared facts;
5. duplicate memories dedupe;
6. later correction supersedes old fact;
7. stale fact does not rank over current correction;
8. retrieval respects prompt budget;
9. ranking is deterministic;
10. provenance remains attached;
11. archive/delete does not corrupt memory references;
12. memory prompt injection stays data;
13. old async extraction cannot overwrite newer state;
14. memory subsystem failure does not break ordinary chat;
15. two characters using the same underlying model do not share memories accidentally.
13. VOICE-005 — Conversational spoken-response style
Goal
Streaming TTS has solved much of the latency problem.
The next question is:
Does the response sound like conversation, or like an essay being read aloud?

Voice conversations should generally favor:
- shorter turns;
- shorter paragraphs;
- natural contractions;
- conversational phrasing;
- less markdown;
- fewer long parentheticals;
- fewer repeated summaries;
- less formal essay structure;
- context-appropriate emotion.
Do not globally degrade text chat.
Implement at prompt-policy level
Do not hard-code personality in the frontend.
Potential modes:
text mode
voice mode
hands-free mode

A character remains the same character.
Only response-shaping guidance changes.
Optional user preference
Potential voice-response-length setting:
Concise
Normal
Detailed

This affects conversational length, not intelligence.
TTS text cleanup
Speech should continue excluding things that should not be spoken:
- hidden reasoning;
- analysis blocks;
- code fences where inappropriate;
- formatting syntax;
- internal metadata;
- raw URL noise.
Displayed chat text can retain richer formatting.
Tests
Verify prompt construction:
1. voice guidance only appears when appropriate;
2. text-only chat remains unchanged;
3. character prompt remains authoritative;
4. hidden reasoning never enters speech;
5. multi-character identity is retained;
6. preference persists;
7. another conversation does not inherit stale mode state.
Then dogfood subjectively.
14. UX-001 — Product polish
Do this after primary voice/memory work.
Do not perform an aesthetic rewrite.
Focus on friction.
Settings
Organize into understandable sections:
Model
Speech to Text
Text to Speech
Hands-Free
Memory
Conversation

Clarify the difference between:
Auto Speak
Voice Mode
Hands-Free

If two historical toggles now mean nearly the same thing, consider simplifying.
Service status
Users should easily see whether:
- LLM;
- STT;
- TTS
are available.
Errors should identify the failed service.
Character voice UI
Make clear:
- voice selected;
- no voice;
- backend unavailable;
- invalid/missing voice.
Accessibility
Ensure:
- keyboard operation;
- labels for icon-only buttons;
- visible focus;
- reasonable contrast;
- no state communicated only by color.
Responsive layout
Test laptop and narrow/mobile viewports.
15. DOCS-001 — Turn the repository into OpenParlor
The repository should stop looking primarily like an internal SillyTavern experiment.
Preserve upstream attribution and licensing, but make OpenParlor the project users encounter.
Recommended documentation:
README.md
ROADMAP.md
CONTRIBUTING.md
docs/ARCHITECTURE.md
docs/VOICE.md
docs/MEMORY.md

README should eventually cover:
- what OpenParlor is;
- local-first philosophy;
- features;
- characters;
- group rooms;
- memory;
- local model connection;
- STT;
- TTS;
- streaming speech;
- Hands-Free;
- installation;
- project status;
- development;
- upstream attribution;
- license.
Do not advertise a one-command installation until it actually works on a clean machine.
16. REL-001 — Clean-install/release hardening
Before calling the project broadly installable, test from a genuinely fresh checkout.
The installation must not depend on:
/home/mark/...
.clinerules
/tmp files
shell aliases
local Qwen workers
gpt-oss workers
development logs

Document:
- supported Node version;
- npm install;
- configuration;
- LLM provider URL;
- STT setup;
- Kokoro setup;
- startup command;
- /openparlor/ URL;
- user data location.
Provide a safe example configuration.
Never commit secrets.
Persistence migrations
If the data model changes:
- preserve existing characters;
- preserve existing conversations;
- preserve memory;
- provide explicit migration;
- test old data loading.
Never silently wipe or "reset" user data as an upgrade strategy.
Backup/export
A first release should have at least a documented reliable backup path.
A giant backup framework is not required.
Users should be able to preserve:
- characters;
- conversations;
- memories;
- configuration where safe.
17. Optional future work
These are not prerequisites for the primary roadmap.
Better TTS expressiveness
Potential future character options:
- speaking rate;
- expressive style;
- pauses;
- voice tuning.
Only add features supported reliably by the actual TTS backend.
Do not sacrifice latency/stability.
Richer room director
Potential future improvements:
- participation frequency;
- who addresses whom;
- character initiative;
- controlled character interruptions;
- conversational turn fairness.
Do not add expensive hidden model calls casually.
Better provider/model UI
Eventually make configured local model switching easier.
Keep sensitive credentials/server information server-side when appropriate.
Go backend
A future Go backend has been discussed.
Do not begin that rewrite now.
A rewrite only makes sense once:
- behavior is stable;
- APIs are documented;
- persistence schema is stable;
- there is a concrete operational reason.
Never combine a backend rewrite with feature development.
18. Things you must not do
Do not:
- rewrite OpenParlor from scratch;
- rewrite Node to Go during the current roadmap;
- discard proven state machines because another implementation looks cleaner;
- remove character identity;
- remove memory provenance;
- leak private memory;
- bypass existing TTS ownership;
- let multiple audio owners operate simultaneously;
- add arbitrary sleeps to resolve races;
- ignore stale callbacks;
- hide failures without tests;
- add mandatory cloud services;
- add telemetry;
- hard-code developer model paths;
- rely on Qwen/gpt-oss development scripts;
- modify unrelated SillyTavern code for convenience;
- automatically merge feature PRs;
- automatically delete branches after merge.
19. Definition of done for a roadmap item
A feature is complete when:
- implementation is focused;
- focused tests pass;
- all OpenParlor tests pass;
- ESLint has no errors;
- git diff --check is clean;
- worktree is clean;
- cancellation paths were reviewed;
- stale callbacks were reviewed;
- privacy impact was reviewed where relevant;
- browser dogfood was performed where relevant;
- no known blocker remains;
- branch is pushed;
- PR to openparlor-main is open.
Then stop and let the human review/merge.
20. Definition of an OpenParlor early-release milestone
A credible early/public pre-release should have:
- clean documented installation;
- reliable single-character chat;
- reliable multi-character rooms;
- character import/export;
- persistent memory across chats;
- tested character memory privacy;
- configured local LLM support;
- working local STT;
- working local TTS;
- streaming TTS before generation completion;
- Hands-Free mode;
- reliable barge-in;
- natural enough endpoint detection;
- reliable Stop;
- no old-audio leak on conversation switch;
- understandable service failures;
- OpenParlor-focused README;
- full OpenParlor tests green;
- no known browser-dogfood blocker.
21. Immediate next task
The next feature is:
VOICE-003 — Hands-Free barge-in

Start with:
cd ~/openparlor || exit 1
git fetch --all --prune
git checkout openparlor-main
git pull --ff-only
git status --short

git checkout -b voice-003-barge-in

Then inspect, at minimum:
public/openparlor/handsfree.js
public/openparlor/audio.js
public/openparlor/app.js
public/openparlor/streaming-tts.js
tests/openparlor/*handsfree*
tests/openparlor/*audio*
tests/openparlor/*stop*

Trace the entire current lifecycle before editing:
mic
-> VAD
-> utterance capture
-> STT
-> send
-> model
-> streaming TTS
-> playback
-> Hands-Free returns to listening

Also trace:
Stop button
-> active-send abort
-> streaming turn cancellation
-> TTS ownership teardown
-> Hands-Free settlement

Key design question
While TTS is playing, how can OpenParlor monitor the microphone, distinguish genuine user speech from AI speaker echo, stop the current turn through the existing cancellation system, and preserve enough microphone pre-roll that the user's first word is not lost?

Do not begin implementation until you can answer that question from the current code.
22. Final instruction
Optimize for correct ownership and natural conversation, not code volume.
Prefer:
explicit state
single ownership
identity guards
AbortController
deterministic tests
small PRs
character privacy
browser dogfood

over:
large rewrites
clever shortcuts
implicit state
timing hacks
silent fallback
duplicated logic

When existing code works, preserve it.
When asynchronous behavior can race, make ownership explicit.
When a feature affects how conversation feels, test it as a user.
When memory concerns private character knowledge, privacy outranks convenience.
When a roadmap feature is finished, stop at the PR boundary.