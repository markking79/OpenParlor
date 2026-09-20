# TASK-004 — Stream OpenParlor chat into the browser

## Goal

Make `/openparlor/` send messages to the authenticated OpenParlor API and append the configured model's streamed response to an Assistant bubble. No character identity is sent to the model.

## Allowed files

- `src/openparlor/chat-router.js`
- `tests/openparlor/chat-router.test.js`
- `public/openparlor/openparlor.js`
- `tests/openparlor/openparlor-stream.test.js` (new, only if browser parser is factored into testable exported code)
- `tests/openparlor/task-004.e2e.js` (new, lightweight Playwright acceptance when authenticated browser state is available)

Do not modify any other files. Do not modify server startup, TASK-001/002 code, HTML/CSS, package files, or public files besides `openparlor.js`.

## Server

- Retain POST `/api/openparlor/chat`; request `{ messages, stream: true }` selects streaming. Existing non-streaming behavior remains supported.
- Use `provider.streamChatCompletion(messages, { signal: request.signal })` or an equivalent request-abort signal.
- Frame output as UTF-8 NDJSON records, one per line: `{ "type":"delta", "text":"..." }`, then `{ "type":"done" }`. Stream errors use `{ "type":"error", "error":"safe text" }` and completion is explicit.
- Correctly decode arbitrary provider chunk boundaries with `TextDecoder(..., { stream: true })`; parse OpenAI-compatible SSE `data:` records, ignore `[DONE]`, extract only safe `choices[0].delta.content` strings. Never forward provider config/secrets/upstream headers.
- Before any bytes, respond controlled JSON errors as TASK-003. After streaming starts, frame safe error records and finish.

## Browser

- Replace `sendDemoMessage` with real authenticated same-origin fetch to `/api/openparlor/chat`; do not supply endpoint/provider/key/configuration/path data.
- Send `messages` containing the current user message and `stream: true`; preserve fixed demo transcript only as display context, not model prompt.
- Add user bubble immediately and an Assistant bubble before streamed content. Read arbitrary fetch chunks through `TextDecoder` and NDJSON buffering; append text directly to that bubble, scroll, and handle done/error.
- Disable duplicate sends while active. Enter sends, Shift+Enter newline. Follow existing CSRF conventions; do not weaken protection.

## Tests/checks

Use mock providers/streams only. Cover valid stream, explicit done, failure before and during stream, malformed request, sanitized stream errors, and arbitrary chunks/framing. Run lint for changed source/public JS and focused node tests. Do not commit/push or begin TASK-005.
