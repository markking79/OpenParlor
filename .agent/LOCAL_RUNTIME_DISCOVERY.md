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
