# OpenParlor Handoff

## Current state

TASK-002 is accepted. The server-only model-provider factory and OpenAI-compatible provider are ready for later route integration.

## Last completed task

TASK-002 — Add OpenParlor model-provider abstraction.

## Important decisions

- Configuration is read exclusively from `<directories.root>/openparlor/config.json`.
- Missing, unreadable, invalid JSON, and malformed configuration return a fresh normalized disabled configuration without creating files or logging content.
- Runtime defaults never contain endpoints or secrets. The only local URL strings are non-routable-port placeholders in the checked-in example configuration required by the task card.
- Providers consume normalized model configuration supplied by callers; they do not read user configuration files directly.
- `fetch` is injectable, API keys are optional, and cancellation is represented by per-request `AbortSignal`.

## Known issues

- The repository has no `node_modules/.bin/jest`; TASK-002 uses Node's built-in test runner and adds no dependencies.
- The local Qwen terminal worker was repeatedly terminated by its 30-second execution wrapper before its first edit. Its scoped implementation was completed directly after those failed attempts.

## Next dependency-first task

TASK-003: add the OpenParlor backend chat endpoint using the accepted model-provider interface, without STT or TTS work.

## Relevant commands

```bash
npm run lint -- --no-cache src/openparlor/model-provider.js src/openparlor/providers/model/openai-compatible.js
node --test tests/openparlor/model-provider.test.js
```

## Notes for the next session

The provider factory is `createModelProvider(modelConfig, options?)`; `OpenAICompatibleModelProvider` provides `getInfo`, `listModels`, `chatCompletion`, and `streamChatCompletion`. Do not add a route until TASK-003.
