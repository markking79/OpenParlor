# OpenParlor Local Runtime Discovery

## Kokoro TTS — verified 2026-09-21

- Process: local `uvicorn api.src.main:app`, listening on `0.0.0.0:8880`.
- OpenAPI: `GET http://127.0.0.1:8880/openapi.json`, title `Kokoro TTS API`,
  version `0.8.0`.
- Stable OpenAI-compatible base URL: `http://127.0.0.1:8880/v1`.
- Model probe: `GET /v1/models`; verified models include `tts-1`, `tts-1-hd`,
  `kokoro`, and `gpt-4o-mini-tts`.
- Voice discovery: `GET /v1/audio/voices`, JSON `{ voices: [{ id, name }] }`.
- Synthesis: `POST /v1/audio/speech` with JSON including `model`, `input`,
  `voice`, and `response_format`. A verified request using `tts-1`,
  `af_bella`, and `response_format: "wav"` returned streamed
  `audio/wav`: 24 kHz, mono, 16-bit PCM.
- The service exposes `X-Accel-Buffering: no` and chunked transfer for audio.

OpenParlor must access this service only through a server-side provider; the
browser must never receive this base URL as a configurable value.

## Local STT — verified 2026-09-21

- No Open WebUI or dedicated transcription HTTP process is currently listening.
  The installed Open WebUI command is available at `~/.local/bin/open-webui`,
  but must not be started just to make OpenParlor depend on its authenticated
  browser/session API.
- The installed local engine is `faster-whisper 1.2.1` in Open WebUI's managed
  Python environment. Both `faster-whisper-large-v3` and the preferred
  `mobiuslabsgmbh/faster-whisper-large-v3-turbo` weights are already present
  in `~/.open-webui/cache/whisper/models`; no model download is needed.
- The usable direct engine contract is `WhisperModel(...).transcribe(audio,
  language?, task='transcribe', beam_size=5, vad_filter?, multilingual?)`.
  It accepts an audio file path, bytes-like stream, or NumPy audio and returns
  an iterable of segments plus detected-language metadata. The Open WebUI
  implementation joins segment text and exposes `{ "text": "..." }`.
- A real local GPU verification used the existing `large-v3-turbo` model with
  CUDA/float16 and a locally generated WAV (`audio/wav`, PCM 16-bit mono,
  24 kHz). It returned the expected text, `OpenParler Transcription
  Verification`, with detected language `en` at probability `1.0`.
- Open WebUI's optional HTTP façade, if intentionally run later, is
  `POST /api/v1/audio/transcriptions` as multipart form data: required `file`
  and optional `language`; successful responses are `{ text, filename }`.
  It requires an authenticated verified user (and the `chat.stt` permission
  for non-admin users), limits files to 20 MiB, and checks configured MIME
  types plus extensions. Its default extension allowlist is `mp3`, `wav`,
  `m4a`, `webm`, `ogg`, `flac`, `mp4`, `mpga`, and `mpeg`; MIME policy is
  administrator-configured.

### Recommended OpenParlor boundary

TASK-STT-002 should provide a server-only local `faster-whisper` adapter that
uses the installed managed Python environment and already-cached
`large-v3-turbo` weights. It should accept bounded audio uploads from the
OpenParlor route and return only normalized transcript text and safe metadata.
Do not expose an Open WebUI session, its configuration, model-cache paths, or
any service credentials to the browser. An OpenAI-compatible HTTP adapter can
remain an explicit future configuration option, but is not the local default.
