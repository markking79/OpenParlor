# TASK-TTS-004 — Play assistant messages

## Goal

Let the browser play, stop, and replay persisted assistant messages through an
authenticated OpenParlor endpoint without exposing the Kokoro URL or provider
configuration.

## Acceptance criteria

- Add an authenticated server-owned synthesis endpoint that accepts only safe
  message text and a selected server-validated voice. It must load the
  requesting user's TTS config, use the configured provider, and return audio
  bytes with a safe content type or an ordinary safe unavailable/input error.
- The browser must never receive a provider base URL, key, or upstream body.
- Each rendered assistant message has accessible play, stop, and replay
  controls. Playback uses a browser Blob/object URL made from the OpenParlor
  response; it does not navigate to a Kokoro URL.
- Stop/replay correctly release audio/object-URL resources and no more than one
  message plays at a time.
- Add deterministic endpoint and UI-helper tests.

## Exact allowlist

- `src/openparlor/tts-router.js`
- `public/openparlor/index.html`
- `public/openparlor/openparlor.js`
- `public/openparlor/openparlor.css`
- `tests/openparlor/tts-router.test.js`
- `tests/openparlor/openparlor-ui.test.js`

Do not edit provider/configuration implementation, persistence, character or
chat routes, package files, or other `.agent` control files. Do not stage,
reset, clean, discard, or modify unrelated existing work.
