# TASK-TTS-002 — TTS provider abstraction

## Goal

Implement a server-side text-to-speech provider abstraction and its verified
Kokoro adapter. The browser remains unable to access or configure Kokoro.

## Acceptance criteria

- Provide `listVoices()`, `synthesize(text, options)`, and `health()` through
  a factory selected by server-side TTS configuration.
- Kokoro must use the verified `/v1/audio/voices`, `/v1/audio/speech`, and
  `/v1/models` interface. Validate safe inputs and return controlled errors.
- Follow the repository's ESM modules and Node test conventions. The local
  Kokoro service needs no API key; support an optional server-side key without
  requiring one or sending an empty authorization header.
- Treat the verified `http://127.0.0.1:8880/v1` as the configured base URL;
  normalize trailing slashes and avoid duplicating `/v1`. Add a deterministic
  test for this and leave no lint errors.
- Do not expose a provider base URL, API key, or raw upstream error body.
- Add focused deterministic tests for requests, responses, validation, and
  failure handling.

## Exact allowlist

- `src/openparlor/tts-provider.js` (new)
- `src/openparlor/providers/tts/kokoro.js` (new)
- `tests/openparlor/tts-provider.test.js` (new)

Do not edit routes, UI, configuration, package files, or other `.agent`
control files. Do not stage, reset, clean, discard, or modify unrelated
existing work.
