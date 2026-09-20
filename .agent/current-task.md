# TASK-003 — Authenticated OpenParlor chat endpoint

## Goal

Add `POST /api/openparlor/chat`, protected by SillyTavern's existing global authentication middleware. It loads only `request.user.directories` through TASK-001, creates a TASK-002 provider, and returns a non-streaming completion. Streaming is deferred to TASK-004 to keep this first integration bounded.

## Allowed files

- `src/openparlor/chat-router.js` (new)
- `tests/openparlor/chat-router.test.js` (new)
- `src/server-startup.js` (only to import and mount the new router at `/api/openparlor` in `setupPrivateEndpoints`)

Do not modify any other file, including TASK-001/002 code, public files, manifests, or SillyTavern core beyond this isolated registration.

## Required behavior

- Export an injectable router factory so Node tests use mock `loadOpenParlorConfig` and `createModelProvider`; the production router uses TASK-001 and TASK-002 exports.
- POST `/chat` accepts exactly a non-empty `messages` array of objects with string `role` and string `content`. Reject malformed/missing payloads with controlled 400 JSON errors.
- Load configuration only with `request.user.directories`; never read request provider fields, URLs, keys, or paths.
- Create the configured provider and call non-streaming `chatCompletion(messages)`.
- Return the provider completion as JSON on success. Translate unavailable configuration/provider failures into controlled safe 4xx/5xx JSON errors, preserve safe provider status/message, and never expose keys/Authorization/configuration or log secrets.
- Do not implement streaming, STT, TTS, characters, memory, groups, UI, or settings.

## Tests and checks

Use `node:test` with mocked dependencies. Cover valid request, missing/malformed messages, disabled config, provider failure, per-user directories forwarding, ignored provider/baseUrl/apiKey request fields, and no secrets in errors.

```bash
npm run lint -- --no-cache src/openparlor/chat-router.js src/server-startup.js
node --test tests/openparlor/chat-router.test.js
```

## Worker instructions

Inspect relevant source first. Implement only this card, do not commit/push or select TASK-004, and report files, checks, and concerns.
