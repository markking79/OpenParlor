# TASK-002 — Add OpenParlor model-provider abstraction

## Goal

Create a server-only, OpenParlor-specific model-provider boundary that consumes the normalized `model` configuration returned by TASK-001. Provide the initial `openai-compatible` implementation without adding a route, UI, or any provider specific to a local model runtime.

## Architecture

```text
OpenParlor configuration
        ↓
model provider factory
        ↓
OpenAICompatibleModelProvider
        ↓
OpenAI-compatible server
```

The factory accepts the existing normalized `config.model` object; it must not read configuration files itself. The implementation must remain independent of Qwen, llama.cpp, and specific model names.

## Allowed files to modify

- `src/openparlor/model-provider.js` (new)
- `src/openparlor/providers/model/openai-compatible.js` (new)
- `tests/openparlor/model-provider.test.js` (new)

Create only parent directories needed for these files. Do not modify TASK-001 files, existing SillyTavern files, package manifests, lockfiles, `.gitignore`, generated files, or `public/openparlor/`.

## Required public interface

Use these exports unless a small naming adjustment is required for established project conventions:

- `createModelProvider(modelConfig, options?)` from `src/openparlor/model-provider.js`
- `OpenAICompatibleModelProvider` from `src/openparlor/providers/model/openai-compatible.js`

The factory must reject unsupported or absent providers with a useful controlled error and must never silently select a different provider. `options.fetch` may be injected for tests; production defaults to global `fetch`.

The provider must expose methods sufficient for future route code:

- provider/model information derived from supplied configuration
- `listModels({ signal }?)`
- non-streaming `chatCompletion(messages, options?)`
- streaming-capable request mechanics, preferably `streamChatCompletion`, which sends `stream: true`, accepts an `AbortSignal`, and returns the response body without SSE parsing, a route, or UI integration.

Both chat methods must accept an optional `AbortSignal` and pass it to fetch. Do not create a global cancellation mechanism.

## OpenAI-compatible behavior

- Read only supplied `modelConfig` from TASK-001.
- Use `GET {baseUrl}/models` and `POST {baseUrl}/chat/completions`.
- Normalize one or more trailing slashes on `baseUrl` so path construction is consistent.
- API key support may come from optional `apiKey` in model configuration. Omit Authorization entirely when empty or absent. When present use standard Bearer authorization.
- `chatCompletion` sends a JSON body containing configured model, supplied messages, and `stream: false`; allow only clearly documented, non-security-sensitive request options needed now.
- Streaming mechanics send configured model and messages with `stream: true`.
- Do not hard-code any URL, local endpoint, API key, model name, Qwen, or llama.cpp identifier. Tests use injected fetch and non-routable example URLs only; they must contact no server.

## Error handling and safety

Return/reject controlled useful errors for provider missing/unsupported, missing base URL, fetch/network failure, non-2xx responses, invalid JSON, and malformed `/models` or chat-completion responses. Preserve safe HTTP status and concise upstream response text when available, but never include API keys, Authorization values, request headers, or sensitive configuration in errors or logs. Do not log secrets. Do not add caching, fallback endpoints/providers, dependencies, routes, UI, prompting, STT, or TTS.

## Tests

Use Node's built-in `node:test` and injected mock fetch. Do not add Jest. Deterministically cover trailing-slash URL normalization, no-key requests, API-key Authorization, `/models` parsing, non-streaming chat construction, streaming request construction and signal forwarding, network failure, non-2xx handling, invalid JSON, and malformed provider responses.

## Required checks

```bash
npm run lint -- --no-cache src/openparlor/model-provider.js src/openparlor/providers/model/openai-compatible.js
node --test tests/openparlor/model-provider.test.js
```

## Out of scope

- Express routes, including `/api/openparlor/chat`
- Browser or `public/openparlor/` work
- Character prompting, storage, streaming-to-browser integration, or SSE parsing
- STT, TTS, provider settings UI, config writing, or migrations
- Changes to SillyTavern core

## Worker instructions

You are the implementation worker. Inspect relevant existing files before editing. Do not redesign architecture, broaden scope, commit, or push. Preserve behavior outside this task and modify only the allowed files. At completion, report files changed, implementation summary, checks and results, and known concerns. Do not select the next task.
