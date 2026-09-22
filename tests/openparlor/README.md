# OpenParlor browser acceptance (STAB-008)

`task-008.e2e.js` is a real-authenticated-browser acceptance harness for the
OpenParlor UI. It is **opt-in and local-only**: it never runs in CI by
default and never commits credentials.

## What it covers

Driven through the real UI (character/conversation CRUD and CSRF hit your
local server; only the model and TTS boundaries are mocked in-browser):

- app loads (`/openparlor/`);
- create characters (with TTS voices) and select them;
- create a two-character conversation;
- group ("everyone") turn → both characters respond;
- explicit speaker turn → only that character responds;
- speaker labels are correct (user labeled "You");
- streamed deltas complete into final bubble text;
- Stop works (playback button states transition play → playing → stopped);
- TTS controls attach to the correct speaker (per-message voice in the
  synthesize request matches that message's character);
- no page or console errors.

Mocked boundaries (in-browser via `page.route`):

- `POST /api/openparlor/chat` — the only model-facing request; no llama.cpp needed;
- `POST /api/openparlor/tts/synthesize` — returns a short deterministic
  silent WAV so Stop (not natural audio end) is what ends playback;
- `GET /api/openparlor/health` and `GET /api/openparlor/prerequisites` —
  service-status endpoints the UI polls on load; a local server may not
  implement them yet, and they are fulfilled so the "no console errors"
  assertion covers real issues only.

Voice *discovery* uses the real `GET /api/openparlor/tts/voices` endpoint,
because the server validates character `tts_voice` values against the
provider's live list. The test captures two real voice IDs from that
response and uses them for the two characters. If the local server has no
TTS provider (fewer than 2 voices), the test skips with a clear message.

## Requirements

- local ST server running (OpenParlor feature enabled);
- a local TTS provider configured so `GET /api/openparlor/tts/voices`
  lists at least 2 voices (otherwise the test skips);
- the Playwright Chromium browser installed under `tests/`.

## Creating authenticated storage state (safe, local, never committed)

1. Start your local server (e.g. `npm start` at the repository root).
2. From `tests/`, run the helper:

   ```sh
   ST_BASE_URL=http://127.0.0.1:8000 node openparlor/make-storage-state.js
   ```

3. A visible browser opens at `/login`. Log in there (or, if your local
   server requires no authentication, just navigate to `/openparlor/`).
   When the OpenParlor UI renders, the script saves the session to
   `tests/openparlor/st-auth.storage-state.json` and exits.

Safety rules:

- The output file is covered by the repository `.gitignore`
  (`*.storage-state.json`). **Never commit, push, or share it.**
- It is a session for your local server only; delete it when you are done.

## Running the acceptance test

From `tests/`:

```sh
ST_BASE_URL=http://127.0.0.1:8000 \
ST_AUTH_STORAGE_STATE="$PWD/openparlor/st-auth.storage-state.json" \
OPENPARLOR_BROWSER_ACCEPTANCE=1 \
npx playwright test openparlor/task-008.e2e.js
```

`OPENPARLOR_BROWSER_ACCEPTANCE=1` and a valid `ST_AUTH_STORAGE_STATE` path
are both required; otherwise the test skips with an explanation.

## Notes

- Each run creates two uniquely suffixed characters (`Monica-<run>`,
  `Doug-<run>`) and one conversation on your local server so repeated runs
  never collide. This is local development data.
- The mocked TTS reply is a few seconds of silence, so the Stop button —
  not the natural audio end — is what the test uses to end playback.
