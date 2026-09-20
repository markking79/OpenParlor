# TASK-LOCAL-002 — Discover local AI services

## Goal

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

## Allowed files

- `src/openparlor/`
- `public/openparlor/`
- `tests/openparlor/`
- `src/server-startup.js` (only when mounting an OpenParlor route)
- `.agent/local-runtime-inventory.md` (only for local-service discovery)
- `.agent/handoff.md`
Do not modify package files, inherited SillyTavern UI, unrelated files, or any GitHub workflow. Never commit or push.
